// Stripe payments: Checkout for the rent (+ bond when it's charged), a card
// hold for the bond on short hires, and the webhook that confirms bookings.
// Nothing is ever marked confirmed from the browser — only from Stripe's webhook.
import Stripe from 'stripe';
import { query } from './db.js';
import { pricing, booking as site, business } from './config.js';
import { deleteBookingFiles } from './uploads.js';

let client = null;
let testClient = null;

/** Tests can swap in a fake Stripe client. */
export function setStripeForTests(fake) { testClient = fake; }

export function stripe() {
  if (testClient) return testClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!client) client = new Stripe(key, { appInfo: { name: business.name } });
  return client;
}

const baseUrl = () => (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const shortDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const bikesLabel = (nums) => (nums.length === 1 ? 'Bike ' : 'Bikes ') + nums.join(', ');

export async function bikeNumbersFor(bookingId) {
  const rows = await query(
    `select bikes.number from booking_bikes bb join bikes on bikes.id = bb.bike_id
      where bb.booking_id = $1 order by bikes.number`, [bookingId]);
  return rows.map((r) => r.number);
}

/** Creates the Stripe Checkout page for a new (pending) booking. */
export async function createBookingCheckout(b, bikeNumbers) {
  const s = stripe();
  const dates = `${shortDate(b.start_date)} – ${shortDate(b.end_date)}`;
  const hire = `Scooter hire: ${bikesLabel(bikeNumbers)}, ${b.days} day${b.days === 1 ? '' : 's'}`;
  const lineItems = [{
    quantity: 1,
    price_data: {
      currency: pricing.currency, unit_amount: b.rent_amount,
      product_data: {
        name: hire,
        description: b.bond_method === 'hold'
          ? `${dates}. After payment, a ${money(b.bond_amount)} bond is held on this card: not charged, released after return.`
          : dates,
      },
    },
  }];
  if (b.delivery_amount > 0) {
    const trips = [b.delivery && 'Delivery', b.collection && 'collection'].filter(Boolean).join(' & ');
    lineItems.push({
      quantity: 1,
      price_data: { currency: pricing.currency, unit_amount: b.delivery_amount, product_data: { name: trips.charAt(0).toUpperCase() + trips.slice(1), description: b.customer_address || undefined } },
    });
  }
  if (b.bond_method === 'charge') {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: pricing.currency, unit_amount: b.bond_amount,
        product_data: { name: 'Refundable bond', description: 'Refunded to your card after the scooters are returned in the same condition.' },
      },
    });
  }
  return s.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    customer_email: b.customer_email,
    customer_creation: 'always',
    client_reference_id: b.id,
    metadata: { bookingId: b.id, kind: 'booking' },
    payment_intent_data: {
      description: `${hire} (${dates})`,
      metadata: { bookingId: b.id, kind: 'booking' },
      // Short hires: save the card so we can place the bond hold straight after.
      ...(b.bond_method === 'hold' ? { setup_future_usage: 'off_session' } : {}),
    },
    custom_text: b.bond_method === 'hold'
      ? { submit: { message: `You pay the amount above now. Straight after, a ${money(b.bond_amount)} bond is HELD on this card (your bank may show it as pending). It is not charged, and it is released after the scooters are returned.` } }
      : undefined,
    expires_at: Math.floor(Date.now() / 1000) + site.checkoutWindowMinutes * 60 + 30,
    success_url: `${baseUrl()}/booked?t=${b.access_token}`,
    cancel_url: `${baseUrl()}/booked?t=${b.access_token}&cancelled=1`,
  }, { idempotencyKey: `checkout-${b.id}` });
}

function money(cents) { return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`; }

/** Card hold (authorise now, capture or release later) using the card saved at checkout. */
export async function placeBondHold(b, customerId, paymentMethodId) {
  try {
    const pi = await stripe().paymentIntents.create({
      amount: b.bond_amount,
      currency: pricing.currency,
      customer: customerId,
      payment_method: paymentMethodId,
      capture_method: 'manual',
      off_session: true,
      confirm: true,
      description: `Bond hold — booking ${b.id.slice(0, 8)}`,
      metadata: { bookingId: b.id, kind: 'bond' },
    }, { idempotencyKey: `bond-hold-${b.id}` });
    return pi.status === 'requires_capture' ? pi : null;
  } catch (err) {
    console.warn(`[stripe] bond hold failed for ${b.id}: ${err.code || err.message}`);
    return null;
  }
}

/** A Checkout page where the customer authorises the bond hold themselves (if the automatic hold failed). */
export async function createBondCheckout(b) {
  return stripe().checkout.sessions.create({
    mode: 'payment',
    ...(b.stripe_customer_id ? { customer: b.stripe_customer_id } : { customer_email: b.customer_email }),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: pricing.currency, unit_amount: b.bond_amount,
        product_data: { name: 'Bond hold (not charged)', description: 'Held on your card and released after the scooters are returned in the same condition.' },
      },
    }],
    payment_intent_data: { capture_method: 'manual', metadata: { bookingId: b.id, kind: 'bond' } },
    metadata: { bookingId: b.id, kind: 'bond' },
    success_url: `${baseUrl()}/booked?t=${b.access_token}`,
    cancel_url: `${baseUrl()}/booked?t=${b.access_token}`,
  });
}

// Called once a booking becomes confirmed (or awaiting_bond) — sends the emails (see notify.js).
// An email problem must never undo a payment, so errors are only logged.
let onConfirmedHook = async () => {};
export function setOnConfirmed(fn) { onConfirmedHook = fn; }
async function onConfirmed(bookingId, status) {
  try { await onConfirmedHook(bookingId, status); } catch (err) { console.error(`[notify] ${bookingId}: ${err.message}`); }
}

async function onRentPaid(bookingId, session) {
  // Claim the booking atomically so a webhook delivered twice is only processed once.
  // (A claim older than 2 minutes means an earlier attempt crashed, so it may be retried.)
  const [b] = await query(
    `update bookings set paid_at = now()
      where id = $1 and status = 'pending_payment'
        and (paid_at is null or paid_at < now() - interval '2 minutes')
      returning *`, [bookingId]);
  if (!b) {
    const [existing] = await query('select status from bookings where id = $1', [bookingId]);
    if (existing?.status === 'cancelled') {
      // Shouldn't happen (cancelling expires the Stripe page), but never keep money for a cancelled booking.
      console.error(`[stripe] payment arrived for cancelled booking ${bookingId}, refunding`);
      await stripe().refunds.create({ payment_intent: session.payment_intent }, { idempotencyKey: `refund-cancelled-${bookingId}` });
    }
    return;
  }
  try {
    const pi = await stripe().paymentIntents.retrieve(session.payment_intent);
    const customerId = session.customer || pi.customer;
    let status = 'confirmed', bondStatus, bondPi = null;
    if (b.bond_method === 'charge') {
      bondStatus = 'charged'; bondPi = pi.id; // bond is part of this payment; refunded later
    } else {
      const hold = await placeBondHold(b, customerId, pi.payment_method);
      if (hold) { bondStatus = 'held'; bondPi = hold.id; } else { bondStatus = 'none'; status = 'awaiting_bond'; }
    }
    await query(
      `update bookings set status = $2, bond_status = $3, stripe_bond_payment_intent_id = $4,
              stripe_payment_intent_id = $5, stripe_customer_id = $6, stripe_checkout_session_id = $7,
              updated_at = now()
        where id = $1`,
      [b.id, status, bondStatus, bondPi, pi.id, customerId, session.id]);
    console.log(`[stripe] booking ${b.id} paid → ${status} (bond ${bondStatus})`);
    await onConfirmed(b.id, status);
  } catch (err) {
    await query('update bookings set paid_at = null where id = $1', [b.id]); // let Stripe's retry try again
    throw err;
  }
}

async function onBondSecured(bookingId, session) {
  const pi = await stripe().paymentIntents.retrieve(session.payment_intent);
  if (pi.status !== 'requires_capture') return;
  const rows = await query(
    `update bookings set status = 'confirmed', bond_status = 'held', stripe_bond_payment_intent_id = $2,
            bond_checkout_session_id = $3, updated_at = now()
      where id = $1 and status = 'awaiting_bond' returning id`, [bookingId, pi.id, session.id]);
  if (rows.length) {
    console.log(`[stripe] bond secured for ${bookingId} → confirmed`);
    await onConfirmed(bookingId, 'confirmed');
  }
}

/** Cancels an unpaid booking and frees its bikes. Returns true if it was cancelled. */
export async function cancelUnpaid(bookingId) {
  const rows = await query(
    `update bookings set status = 'cancelled', updated_at = now()
      where id = $1 and status = 'pending_payment' and paid_at is null returning id`, [bookingId]);
  if (rows.length) {
    await query(`delete from booking_media where booking_id = $1 and phase = 'licence'`, [bookingId]);
    await deleteBookingFiles(bookingId);
  }
  return rows.length > 0;
}

/**
 * Asks Stripe directly whether an unpaid booking's checkout has been paid, and confirms it if so.
 * Used by the "confirming your payment" page so the customer isn't left waiting on the webhook.
 * Safe: the answer comes from Stripe's API (with our secret key), never from the browser.
 */
export async function syncCheckout(b) {
  if (!stripe() || b.status !== 'pending_payment' || !b.stripe_checkout_session_id) return false;
  const s = await stripe().checkout.sessions.retrieve(b.stripe_checkout_session_id);
  if (s.metadata?.bookingId !== b.id || s.metadata?.kind !== 'booking') return false;
  if (s.status !== 'complete' || s.payment_status !== 'paid') return false;
  await onRentPaid(b.id, s);
  return true;
}

/** Handles a verified Stripe webhook event. */
export async function handleStripeEvent(event) {
  const s = event.data.object;
  const bookingId = s.metadata?.bookingId;
  if (!bookingId) return;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (s.metadata.kind === 'booking' && s.payment_status === 'paid') await onRentPaid(bookingId, s);
      if (s.metadata.kind === 'bond') await onBondSecured(bookingId, s);
      break;
    case 'checkout.session.expired':
      if (s.metadata.kind === 'booking') await cancelUnpaid(bookingId);
      break;
    default:
      break;
  }
}
