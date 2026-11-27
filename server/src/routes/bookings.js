import { Router } from 'express';
import crypto from 'node:crypto';
import { tx, query } from '../db.js';
import { decodeImageDataUrl, saveLicencePhotos, deleteBookingFiles } from '../uploads.js';
import { stripe, createBookingCheckout, createBondCheckout, cancelUnpaid, bikeNumbersFor, syncCheckout } from '../payments.js';
import { quote, todayLocal, dayDiff, isIsoDate } from '../pricing.js';
import { tripOpts } from './public.js';
import { freeBikeIds } from '../availability.js';
import { buildAgreement, allItemIds, AGREEMENT_VERSION } from '../agreement.js';
import { booking as site } from '../config.js';
import { rateLimit, clientIp } from '../rateLimit.js';
import { track } from '../visitors.js';

const r = Router();

export const LICENCE_TYPES = ['Full car licence', 'Provisional car licence', 'Motorcycle licence', 'International licence'];
// Licence types accepted for scooters over 50cc (an international licence must include motorcycles — declared in the agreement).
const MOTORCYCLE_OK = ['Motorcycle licence', 'International licence'];

// GET /api/agreement?start=&end=&count= — the wording the customer will sign
r.get('/agreement', (req, res) => {
  const q = quote(String(req.query.start || ''), String(req.query.end || ''), req.query.count || 1, new Date(), tripOpts(req.query));
  if (q.error) return res.status(400).json({ error: q.error });
  res.json({ version: AGREEMENT_VERSION, sections: buildAgreement(q) });
});

/** Counts digits in any script (some phone keyboards type full-width or Arabic-Indic digits). */
export function phoneDigitCount(phone) {
  return (phone.normalize('NFKC').match(/\p{Nd}/gu) || []).length;
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const yesNo = (v) => (v === 'Yes' ? true : v === 'No' ? false : null);

/** Returns { data } or { error } with a customer-friendly message. */
export function validateBooking(body, now = new Date()) {
  const b = body || {};
  const raw = Array.isArray(b.bikeIds) ? b.bikeIds : [];
  const bikeIds = [...new Set(raw.map(Number))].sort((x, y) => x - y);
  if (!bikeIds.length || raw.length !== bikeIds.length || bikeIds.some((id) => !Number.isInteger(id) || id < 1)) {
    return { error: 'Please choose your scooters.' };
  }
  const q = quote(str(b.start, 10), str(b.end, 10), bikeIds.length, now, { delivery: b.delivery === true, collection: b.collection === true });
  if (q.error) return { error: q.error };

  const d = {
    name: str(b.name, 120),
    dob: str(b.dob, 10),
    phone: str(b.phone, 40),
    email: str(b.email, 200).toLowerCase(),
    address: str(b.address, 300),
    licCountry: str(b.licCountry, 80),
    licNumber: str(b.licNumber, 60),
    licType: str(b.licType, 60),
    licExpiry: str(b.licExpiry, 10),
    lic12m: yesNo(b.lic12m),
    accidents: yesNo(b.accidents),
    accidentInfo: str(b.accidentInfo, 1000),
    restrictions: yesNo(b.restrictions),
    restrictionInfo: str(b.restrictionInfo, 1000),
    signatureName: str(b.signatureName, 120),
    signatureDate: str(b.signatureDate, 10),
    // Random key made by the booking page; the same key on a retry returns the same reservation.
    requestKey: typeof b.requestKey === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(b.requestKey) ? b.requestKey : null,
  };

  if (!d.name || !d.phone || !d.email || !isIsoDate(d.dob)) return { error: 'Please fill in all required renter details.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return { error: 'Please enter a valid email address.' };
  const phoneDigits = phoneDigitCount(d.phone);
  if (phoneDigits < 8 || phoneDigits > 15) {
    console.warn(`[booking] phone rejected: ${phoneDigits} digits, ${d.phone.length} characters`); // never log the number
    return { error: 'Please enter your mobile number with its area code, e.g. 0412 345 678 or +61 412 345 678.' };
  }
  if ((q.delivery || q.collection) && d.address.length < 5) {
    return { error: `Please enter the address for ${q.delivery && q.collection ? 'delivery and collection' : q.delivery ? 'delivery' : 'collection'}.` };
  }
  if (dayDiff(d.dob, todayLocal(now)) < 16 * 365) return { error: 'Please check your date of birth.' };
  if (!d.licNumber || !LICENCE_TYPES.includes(d.licType) || d.lic12m === null) return { error: 'Please complete the licence details.' };
  if (d.licExpiry && !isIsoDate(d.licExpiry)) return { error: 'Please check the licence expiry date.' };
  if (d.licExpiry && d.licExpiry < q.end) return { error: 'Your licence expires before the end of the hire.' };
  if (d.accidents === null || d.restrictions === null) return { error: 'Please complete the driving history section.' };

  const sections = buildAgreement(q);
  const accepted = new Set(Array.isArray(b.accepted) ? b.accepted : []);
  if (!allItemIds(sections).every((id) => accepted.has(id))) return { error: 'Please agree to all declarations before continuing.' };
  if (!d.signatureName) return { error: 'Please type your full name as your signature.' };
  if (!isIsoDate(d.signatureDate) || Math.abs(dayDiff(d.signatureDate, todayLocal(now))) > 1) {
    return { error: 'The signature date must be today.' };
  }
  const photos = Array.isArray(b.licencePhotos) ? b.licencePhotos : [];
  if (photos.length < bikeIds.length) {
    return { error: `Please add a photo of each rider's licence (${bikeIds.length} needed).` };
  }
  if (photos.length > MAX_LICENCE_PHOTOS) return { error: `Please add no more than ${MAX_LICENCE_PHOTOS} licence photos.` };
  const images = photos.map(decodeImageDataUrl);
  if (images.some((img) => !img)) return { error: 'One of the licence photos could not be read. Please take it again.' };

  return { data: { ...d, bikeIds, quote: q, sections, images } };
}

const MAX_LICENCE_PHOTOS = 10;

// POST /api/bookings — reserves the bike (unpaid, expires) and stores the signed agreement
r.post('/bookings', rateLimit({ windowMs: 60 * 60 * 1000, max: 15 }), async (req, res) => {
  const v = validateBooking(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.data;
  const q = d.quote;
  const now = new Date();

  const agreement = {
    version: AGREEMENT_VERSION,
    sections: d.sections.map((s) => ({ title: s.title, items: s.items.map((i) => ({ ...i, accepted: true })) })),
    userAgent: str(req.get('user-agent'), 300),
  };

  // Save the licence photos first (under a pre-made booking id), then the booking.
  const bookingId = crypto.randomUUID();
  const accessToken = crypto.randomBytes(24).toString('base64url');
  const files = await saveLicencePhotos(bookingId, d.images);

  const result = await tx(async (t) => {
    // Lock the bike rows (in id order) so two people can't grab the same bike at the same moment.
    const bikes = await t.query('select id, number, name, needs_motorcycle_licence from bikes where id = any($1::int[]) order by id for update', [d.bikeIds]);
    if (bikes.length !== d.bikeIds.length) return { error: 'One of those scooters no longer exists — please pick again.', status: 400 };
    const bigBike = bikes.find((bk) => bk.needs_motorcycle_licence);
    if (bigBike && !MOTORCYCLE_OK.includes(d.licType)) {
      return { error: `Bike ${bigBike.number} (${bigBike.name}) needs a motorcycle licence. Please choose a different scooter, or select your motorcycle licence.`, status: 400 };
    }
    if (d.requestKey) {
      // Same submission sent again (the first reply never reached the phone): hand back that booking.
      const [prev] = await t.query(
        `select * from bookings where request_key = $1 and status <> 'cancelled'`, [d.requestKey]);
      if (prev) return { existing: prev };
    }
    const free = new Set(await freeBikeIds(d.bikeIds, q.start, q.end, t.query));
    const taken = bikes.filter((bk) => !free.has(bk.id));
    if (taken.length) {
      const names = taken.map((bk) => 'Bike ' + bk.number).join(', ');
      return { error: `Sorry, ${names} was just booked for those dates — please pick again.`, status: 409 };
    }
    const row = (await t.query(
      `insert into bookings (
         id, access_token, scooter_count, customer_name, customer_email, customer_phone, customer_dob,
         customer_address, riders, licence_country, licence_number, licence_type, licence_expiry,
         licence_12_months, at_fault_accidents, accident_details, driving_restrictions, restriction_details,
         start_date, end_date, days, rent_amount, bond_amount, bond_method,
         status, pending_expires_at, agreement, signature_name, signature_date, agreement_signed_at, signer_ip,
         request_key, delivery, collection, delivery_amount)
       values ($30, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               'pending_payment', now() + ($24 || ' minutes')::interval, $25, $26, $27, $28, $29, $31, $32, $33, $34)
       returning *`,
      [
        // (riders column = number of scooters)
        accessToken, bikes.length, d.name, d.email, d.phone, d.dob,
        d.address || null, String(bikes.length), d.licCountry || null, d.licNumber, d.licType, d.licExpiry || null,
        d.lic12m, d.accidents, d.accidentInfo || null, d.restrictions, d.restrictionInfo || null,
        q.start, q.end, q.days, q.rent, q.bond, q.bondMethod,
        String(site.pendingHoldMinutes), JSON.stringify(agreement), d.signatureName, d.signatureDate,
        now.toISOString(), clientIp(req), bookingId, d.requestKey,
        q.delivery, q.collection, q.deliveryTotal,
      ],
    ))[0];
    for (const bk of bikes) {
      await t.query('insert into booking_bikes (booking_id, bike_id) values ($1, $2)', [row.id, bk.id]);
    }
    for (const f of files) {
      await t.query(
        `insert into booking_media (booking_id, phase, file_path, mime_type, size_bytes) values ($1, 'licence', $2, $3, $4)`,
        [row.id, f.relPath, f.mime, f.size]);
    }
    return { booking: row, bikeNumbers: bikes.map((bk) => bk.number).sort((x, y) => x - y) };
  }).catch(async (err) => { await deleteBookingFiles(bookingId); throw err; });

  if (result.error) {
    await deleteBookingFiles(bookingId);
    return res.status(result.status).json({ error: result.error });
  }
  if (result.existing) {
    await deleteBookingFiles(bookingId); // this attempt's copy of the photos isn't needed
    return res.json(await resumeBooking(result.existing));
  }

  let checkoutUrl = null;
  if (stripe()) {
    try {
      const session = await createBookingCheckout(result.booking, result.bikeNumbers);
      await query('update bookings set stripe_checkout_session_id = $2 where id = $1', [bookingId, session.id]);
      checkoutUrl = session.url;
    } catch (err) {
      console.error('[stripe] could not create checkout:', err.message);
      await cancelUnpaid(bookingId);
      return res.status(502).json({ error: 'Online payment is unavailable right now. Please try again in a few minutes or call us.' });
    }
  }
  track(req, 'checkout', { start: q.start, end: q.end, days: q.days, scooters: q.count, amount: q.rent + q.deliveryTotal, bookingId });
  res.status(201).json({ bookingId, bikeNumbers: result.bikeNumbers, quote: q, checkoutUrl });
});

/** Reply for a repeated submission: send the customer on to the same payment page (or its status page). */
async function resumeBooking(b) {
  const statusPage = `/booked?t=${b.access_token}`;
  let checkoutUrl = stripe() ? statusPage : null;
  if (b.status === 'pending_payment' && !b.paid_at && b.stripe_checkout_session_id && stripe()) {
    const s = await stripe().checkout.sessions.retrieve(b.stripe_checkout_session_id).catch(() => null);
    if (s?.status === 'open' && s.url) checkoutUrl = s.url;
  }
  return {
    bookingId: b.id, bikeNumbers: await bikeNumbersFor(b.id),
    quote: { start: b.start_date, end: b.end_date, days: b.days, rent: b.rent_amount, bond: b.bond_amount },
    checkoutUrl, resumed: true,
  };
}

async function findByToken(t) {
  if (typeof t !== 'string' || t.length < 20 || t.length > 64) return null;
  return (await query('select * from bookings where access_token = $1', [t]))[0] || null;
}

// GET /api/booking-status?t=… — what the customer sees after Stripe sends them back
r.get('/booking-status', async (req, res) => {
  let b = await findByToken(req.query.t);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (b.status === 'pending_payment' && !b.paid_at) {
    try {
      if (await syncCheckout(b)) b = await findByToken(req.query.t);
    } catch (err) {
      console.warn(`[stripe] status check for ${b.id} failed: ${err.message}`);
    }
  }
  res.json({
    status: b.status, bondStatus: b.bond_status, bondMethod: b.bond_method,
    bikeNumbers: await bikeNumbersFor(b.id),
    start: b.start_date, end: b.end_date, days: b.days,
    rent: b.rent_amount, bond: b.bond_amount, email: b.customer_email,
    name: b.customer_name.split(' ')[0],
  });
});

// POST /api/bookings/cancel { t } — customer backed out of Stripe: free the bikes now
r.post('/bookings/cancel', async (req, res) => {
  const b = await findByToken(req.body?.t);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (b.status !== 'pending_payment' || b.paid_at) return res.json({ cancelled: false, status: b.status });
  if (b.stripe_checkout_session_id && stripe()) {
    try {
      await stripe().checkout.sessions.expire(b.stripe_checkout_session_id);
    } catch (err) {
      // Already paid or already expired — let the webhook decide.
      const s = await stripe().checkout.sessions.retrieve(b.stripe_checkout_session_id).catch(() => null);
      if (s?.status === 'complete') return res.json({ cancelled: false, status: 'processing' });
    }
  }
  res.json({ cancelled: await cancelUnpaid(b.id) });
});

// POST /api/bond-checkout { t } — secure the bond if the automatic card hold didn't go through
r.post('/bond-checkout', async (req, res) => {
  const b = await findByToken(req.body?.t);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (b.status !== 'awaiting_bond') return res.status(400).json({ error: 'Your bond is already sorted.' });
  if (!stripe()) return res.status(503).json({ error: 'Online payment is unavailable right now.' });
  const session = await createBondCheckout(b);
  res.json({ url: session.url });
});

export default r;
