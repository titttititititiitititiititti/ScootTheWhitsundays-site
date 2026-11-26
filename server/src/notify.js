// Booking emails: the customer's confirmation (lockbox + pickup instructions)
// and the owner's "new booking" notification. Each booking's confirmation is
// sent once — claimed with bookings.confirmation_sent_at — and a sweep every
// few minutes retries any that failed (e.g. Resend was briefly down).
import { query } from './db.js';
import { sendEmail, escapeHtml as h } from './email.js';
import { booking as site, business } from './config.js';

const baseUrl = () => (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const fmt = (iso, opts) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', ...opts });
const longDate = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });   // Mon 1 Dec
const shortDate = (iso) => fmt(iso, { day: 'numeric', month: 'short' });                     // 1 Dec
const bikesLabel = (nums) => (nums.length === 1 ? 'Bike ' : 'Bikes ') + nums.join(', ');

const tripsLabel = (b) => (b.delivery && b.collection ? 'Delivery + collection' : b.delivery ? 'Delivery' : 'Collection');

export const tripUrl = (b) => `${baseUrl()}/trip?t=${b.access_token}`;
export const statusUrl = (b) => `${baseUrl()}/booked?t=${b.access_token}`;

async function loadBikes(bookingId) {
  return query(
    `select bikes.number, bikes.name, bikes.lockbox_number, bikes.lockbox_code
       from booking_bikes bb join bikes on bikes.id = bb.bike_id
      where bb.booking_id = $1 order by bikes.number`, [bookingId]);
}

// ── Shared layout (inline styles: email apps ignore <style> blocks) ──────────
function layout(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#faf6f1;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2c1810">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf6f1"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e8ddd4">
<tr><td style="background:#8b2a3a;background-image:linear-gradient(135deg,#3d1832 0%,#8b2a3a 40%,#c44a2f 65%,#e8853a 85%,#f5c45a 100%);padding:22px 20px;color:#ffffff">
<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">${h(business.name)}</div>
<div style="font-size:22px;font-weight:700;margin-top:4px">${h(title)}</div></td></tr>
<tr><td style="padding:20px;font-size:15px;line-height:1.5">${bodyHtml}</td></tr>
<tr><td style="padding:14px 20px;border-top:1px solid #e8ddd4;font-size:12px;color:#8f7566">${h(business.name)} · Airlie Beach QLD · <a href="tel:${business.phone.replace(/\s/g, '')}" style="color:#8f7566">${h(business.phone)}</a></td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href, label) =>
  `<a href="${h(href)}" style="display:inline-block;background:#c0392b;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${h(label)}</a>`;
const box = (inner) => `<div style="background:#faf6f1;border:1px solid #e8ddd4;border-radius:10px;padding:12px 14px;margin:12px 0">${inner}</div>`;
const row = (k, v) => `<tr><td style="padding:3px 12px 3px 0;color:#6b4e42;vertical-align:top;white-space:nowrap">${h(k)}</td><td style="padding:3px 0">${v}</td></tr>`;

// ── Customer confirmation ────────────────────────────────────────────────────
export function customerConfirmation(b, bikes) {
  const first = b.customer_name.split(' ')[0];
  const bondLine = b.bond_status === 'held'
    ? `${money(b.bond_amount)} hold on your card (not charged — released after return)`
    : `${money(b.bond_amount)} paid (refunded to your card after return)`;
  const lockboxRows = bikes.map((bk) => {
    const lb = bk.lockbox_number && bk.lockbox_code
      ? `Lockbox <b>${h(bk.lockbox_number)}</b> · code <b style="font-size:17px;letter-spacing:.1em">${h(bk.lockbox_code)}</b>`
      : `<i>We'll text you the lockbox code before your pickup.</i>`;
    return `<tr><td style="padding:6px 12px 6px 0;font-weight:700;white-space:nowrap;vertical-align:top">Bike ${bk.number}</td><td style="padding:6px 0">${h(bk.name)}<br>${lb}</td></tr>`;
  }).join('');
  const steps = site.pickupInstructions.map((s) => `<li style="margin:4px 0">${h(s)}</li>`).join('');

  const html = layout("You're booked!", `
<p style="margin:0 0 12px">Hi ${h(first)}, thanks for booking with us. Here is everything you need to pick up your scooter${bikes.length > 1 ? 's' : ''}.</p>
${box(`<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px">
${row(b.delivery ? 'Delivery' : 'Pickup', `<b>${h(longDate(b.start_date))}</b>, from ${h(site.pickupFromTime)}${b.delivery ? `<br>We'll bring ${bikes.length > 1 ? 'the scooters' : 'it'} to <b>${h(b.customer_address)}</b> and text you to arrange a time.` : ''}`)}
${row(b.collection ? 'Collection' : 'Return', `<b>${h(longDate(b.end_date))}</b>, by ${h(site.returnByTime)}${b.collection ? `<br>We'll collect from <b>${h(b.customer_address)}</b>.` : ''}`)}
${!b.delivery || !b.collection ? row('Carport', h(site.pickupAddress)) : ''}
</table>`)}
<h3 style="font-size:16px;margin:18px 0 6px">Your scooter${bikes.length > 1 ? 's' : ''} and lockbox${bikes.length > 1 ? 'es' : ''}</h3>
${box(`<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px">${lockboxRows}</table>`)}
<h3 style="font-size:16px;margin:18px 0 6px">Pickup &amp; return</h3>
<ol style="margin:0;padding-left:20px">${steps}</ol>
<h3 style="font-size:16px;margin:18px 0 6px">Where you can ride</h3>
<p style="margin:0 0 6px">${h(site.ridingArea.summary)}</p>
<ul style="margin:0 0 6px;padding-left:20px">${site.ridingArea.noGo.map((s) => `<li style="margin:4px 0"><b>${h(s)}</b></li>`).join('')}</ul>
<h3 style="font-size:16px;margin:18px 0 6px">Videos at pickup and return</h3>
<p style="margin:0 0 12px">Before you ride off, and again when you return, film a quick walk-around (under 1 minute) of each scooter on your trip page. That's how we return your bond quickly.</p>
<p style="margin:16px 0">${button(tripUrl(b), 'Open your trip page')}</p>
<h3 style="font-size:16px;margin:18px 0 6px">Payment</h3>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">
${row('Hire', `${money(b.rent_amount)} paid · ${b.days} day${b.days === 1 ? '' : 's'} · ${h(bikesLabel(bikes.map((x) => x.number)))}`)}
${b.delivery_amount ? row(tripsLabel(b), `${money(b.delivery_amount)} paid`) : ''}
${row('Bond', h(bondLine))}
</table>
<p style="margin:18px 0 0">Questions or running late? Call or text ${h(business.phone)} — or just reply to this email.</p>`);

  const text = [
    `Hi ${first}, you're booked with ${business.name}!`,
    '',
    b.delivery ? `Delivery: ${longDate(b.start_date)} to ${b.customer_address} (we'll text you a time)` : `Pickup: ${longDate(b.start_date)}, from ${site.pickupFromTime} at ${site.pickupAddress}`,
    b.collection ? `Collection: ${longDate(b.end_date)} by ${site.returnByTime} from ${b.customer_address}` : `Return: ${longDate(b.end_date)}, by ${site.returnByTime} to ${site.pickupAddress}`,
    '',
    ...bikes.map((bk) => `Bike ${bk.number} (${bk.name}): ` + (bk.lockbox_number && bk.lockbox_code
      ? `lockbox ${bk.lockbox_number}, code ${bk.lockbox_code}` : `we'll text you the lockbox code before pickup`)),
    '',
    ...site.pickupInstructions.map((s, i) => `${i + 1}. ${s}`),
    '',
    site.ridingArea.summary,
    ...site.ridingArea.noGo.map((s) => `- ${s}`),
    '',
    `Film a quick walk-around of each scooter at pickup and return on your trip page: ${tripUrl(b)}`,
    '',
    `Hire: ${money(b.rent_amount)} paid. Bond: ${bondLine}.`,
    `Questions? Call or text ${business.phone}.`,
  ].join('\n');

  return {
    to: b.customer_email,
    subject: `You're booked: ${bikesLabel(bikes.map((x) => x.number))}, ${shortDate(b.start_date)}–${shortDate(b.end_date)} | ${business.name}`,
    html, text,
    replyTo: process.env.OWNER_NOTIFY_EMAIL || undefined,
    idempotencyKey: `confirm-customer-${b.id}`,
  };
}

// ── Owner notification ───────────────────────────────────────────────────────
export function ownerNotification(b, bikes, licencePhotoCount) {
  const nums = bikes.map((x) => x.number);
  const missing = bikes.filter((bk) => !bk.lockbox_number || !bk.lockbox_code).map((bk) => bk.number);
  const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');
  const bondLine = { held: `${money(b.bond_amount)} card hold`, charged: `${money(b.bond_amount)} charged (refund after return)` }[b.bond_status] || b.bond_status;

  const html = layout('New booking', `
${missing.length ? `<div style="background:#fdecea;border:1px solid #c0392b;border-radius:10px;padding:10px 12px;margin:0 0 12px;color:#8b2a3a"><b>No lockbox code set for ${h(bikesLabel(missing))}.</b> The customer was told you'll text it — please send it before pickup.</div>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px">
${row('Customer', `<b>${h(b.customer_name)}</b>`)}
${row('Phone', `<a href="tel:${h(b.customer_phone.replace(/\s/g, ''))}" style="color:#c0392b">${h(b.customer_phone)}</a>`)}
${row('Email', `<a href="mailto:${h(b.customer_email)}" style="color:#c0392b">${h(b.customer_email)}</a>`)}
${row('Scooters', h(bikesLabel(nums)) + ` (${bikes.map((x) => h(x.name)).join(', ')})`)}
${row('Dates', `${h(longDate(b.start_date))} → ${h(longDate(b.end_date))} · ${b.days} day${b.days === 1 ? '' : 's'}`)}
${row('Hire paid', money(b.rent_amount))}
${b.delivery || b.collection ? row(tripsLabel(b), `<b>${h(b.customer_address)}</b> · ${money(b.delivery_amount)} paid`) : row('Delivery', 'No — using the carport')}
${row('Bond', h(bondLine))}
${row('Date of birth', h(b.customer_dob))}
${row('Address', h(b.customer_address || '—'))}
${row('Licence', h([b.licence_type, b.licence_number, b.licence_country, b.licence_expiry && `exp ${b.licence_expiry}`].filter(Boolean).join(' · ')))}
${row('Licence 12m+', yn(b.licence_12_months))}
${row('At-fault accidents', yn(b.at_fault_accidents) + (b.accident_details ? ` — ${h(b.accident_details)}` : ''))}
${row('Restrictions', yn(b.driving_restrictions) + (b.restriction_details ? ` — ${h(b.restriction_details)}` : ''))}
${row('Licence photos', `${licencePhotoCount} uploaded`)}
${row('Signed', `${h(b.signature_name)} on ${h(b.signature_date)}`)}
</table>
<p style="margin:14px 0 0;font-size:13px;color:#6b4e42">Booking ${h(b.id.slice(0, 8))}. Reply to this email to contact the customer.</p>`);

  const text = [
    `New booking: ${b.customer_name}`,
    missing.length ? `!! No lockbox code set for ${bikesLabel(missing)} — text it to the customer before pickup.` : '',
    `Phone: ${b.customer_phone}`, `Email: ${b.customer_email}`,
    `Scooters: ${bikesLabel(nums)}`,
    `Dates: ${longDate(b.start_date)} → ${longDate(b.end_date)} (${b.days} days)`,
    `Hire paid: ${money(b.rent_amount)}. Bond: ${bondLine}.`,
    b.delivery || b.collection ? `${tripsLabel(b)}: ${b.customer_address} (${money(b.delivery_amount)} paid)` : 'No delivery — carport pickup and return.',
    `Licence: ${b.licence_type} ${b.licence_number}. Photos: ${licencePhotoCount}.`,
    `Signed: ${b.signature_name} on ${b.signature_date}`,
  ].filter(Boolean).join('\n');

  return {
    to: process.env.OWNER_NOTIFY_EMAIL || '(OWNER_NOTIFY_EMAIL not set)',
    subject: `Booking: ${b.customer_name} – ${bikesLabel(nums)} – ${shortDate(b.start_date)}–${shortDate(b.end_date)}${b.delivery || b.collection ? ` – ${tripsLabel(b)}` : ''}`,
    html, text,
    replyTo: b.customer_email,
    idempotencyKey: `confirm-owner-${b.id}`,
  };
}

// ── "One more step" email when the automatic bond hold didn't go through ─────
export function bondNeeded(b) {
  const first = b.customer_name.split(' ')[0];
  const html = layout('One more step', `
<p style="margin:0 0 12px">Hi ${h(first)}, your hire payment went through, but we couldn't place the ${money(b.bond_amount)} bond hold on your card.</p>
<p style="margin:0 0 12px">Your scooters are reserved — please confirm the bond hold (it isn't charged) to finish your booking and get your lockbox code.</p>
<p style="margin:16px 0">${button(statusUrl(b), 'Confirm bond hold')}</p>
<p style="margin:0">Trouble? Call or text ${h(business.phone)}.</p>`);
  return {
    to: b.customer_email,
    subject: `Action needed: confirm your bond hold | ${business.name}`,
    html,
    text: `Hi ${first}, your hire payment went through but the ${money(b.bond_amount)} bond hold didn't. Please confirm it here: ${statusUrl(b)}`,
    replyTo: process.env.OWNER_NOTIFY_EMAIL || undefined,
    idempotencyKey: `bond-needed-${b.id}`,
  };
}

const ownerWanted = () => Boolean(process.env.OWNER_NOTIFY_EMAIL || !process.env.RESEND_API_KEY);

/**
 * Sends one email for a booking at most once, using `column` as the claim.
 * On failure the claim is released so the sweep can retry.
 */
async function sendOnce(bookingId, column, build) {
  const [b] = await query(
    `update bookings set ${column} = now()
      where id = $1 and status = 'confirmed' and ${column} is null returning *`, [bookingId]);
  if (!b) return false;
  try {
    await sendEmail(await build(b));
    return true;
  } catch (err) {
    console.error(`[email] ${column === 'owner_notified_at' ? 'owner notification' : 'customer confirmation'} for ${b.id} failed: ${err.message}`);
    await query(`update bookings set ${column} = null where id = $1`, [b.id]).catch(() => {});
    return false;
  }
}

/** Sends the customer confirmation and the owner notification for a confirmed booking (each once). Never throws. */
export async function sendConfirmation(bookingId) {
  const customer = await sendOnce(bookingId, 'confirmation_sent_at', async (b) => customerConfirmation(b, await loadBikes(b.id)));
  let owner = false;
  if (ownerWanted()) {
    owner = await sendOnce(bookingId, 'owner_notified_at', async (b) => {
      const [{ n }] = await query(`select count(*) as n from booking_media where booking_id = $1 and phase = 'licence'`, [b.id]);
      return ownerNotification(b, await loadBikes(b.id), n);
    });
  } else {
    console.warn('[email] OWNER_NOTIFY_EMAIL is not set — owner notification skipped');
  }
  if (customer || owner) console.log(`[email] booking ${bookingId}: ${[customer && 'customer', owner && 'owner'].filter(Boolean).join(' + ')} email sent`);
  return customer || owner;
}

/** Called by payments when a booking is confirmed (or is waiting on its bond). */
export async function onBookingConfirmed(bookingId, status) {
  try {
    if (status === 'confirmed') return await sendConfirmation(bookingId);
    if (status === 'awaiting_bond') {
      const [b] = await query('select * from bookings where id = $1', [bookingId]);
      if (b) await sendEmail(bondNeeded(b));
    }
  } catch (err) {
    console.error(`[email] booking ${bookingId} (${status}): ${err.message}`);
  }
  return false;
}

/** Retries confirmations that failed to send. */
export async function retryUnsentConfirmations() {
  const rows = await query(
    `select id from bookings where status = 'confirmed'
        and (confirmation_sent_at is null or ($1 and owner_notified_at is null))
        and end_date >= current_date and created_at > now() - interval '60 days' limit 20`, [ownerWanted()]);
  for (const r of rows) await sendConfirmation(r.id);
  return rows.length;
}

export function startEmailRetrySweep(everyMs = 5 * 60 * 1000) {
  const t = setInterval(() => retryUnsentConfirmations().catch((e) => console.error('[email] sweep:', e.message)), everyMs);
  t.unref();
  return t;
}
