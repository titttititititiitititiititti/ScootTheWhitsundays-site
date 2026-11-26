// The customer's trip page (/trip?t=…): pickup and return videos per scooter. The long random token in the link is the only key,
// exactly like the link in the confirmation email.
import { Router } from 'express';
import { query } from '../db.js';
import { todayLocal, dayDiff } from '../pricing.js';
import { booking as site, business } from '../config.js';
import { saveTripUpload, MAX_TRIP_FILE_BYTES, MAX_TRIP_BYTES_PER_BOOKING } from '../uploads.js';
import { rateLimit } from '../rateLimit.js';

const r = Router();
const TRIP_STATUSES = ['confirmed', 'active', 'returned', 'bond_released'];

async function findTrip(t) {
  if (typeof t !== 'string' || t.length < 20 || t.length > 64) return null;
  const [b] = await query('select * from bookings where access_token = $1', [t]);
  return b || null;
}

async function bikesFor(bookingId) {
  return query(
    `select bikes.number, bikes.name from booking_bikes bb join bikes on bikes.id = bb.bike_id
      where bb.booking_id = $1 order by bikes.number`, [bookingId]);
}

/** Which actions are open today. Return videos can be added up to a week after the end date (in case of a late upload). */
export function tripWindows(b, today = todayLocal()) {
  const fromStart = dayDiff(b.start_date, today); // days since pickup day (negative = before)
  const fromEnd = dayDiff(b.end_date, today);
  const live = ['confirmed', 'active'].includes(b.status);
  return {
    pickup: live && fromStart >= -1 && fromEnd <= 0,
    return: live && fromStart >= 0 && fromEnd <= 7,
  };
}

// GET /api/trip?t= — everything the trip page shows
r.get('/trip', async (req, res) => {
  const b = await findTrip(req.query.t);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (!TRIP_STATUSES.includes(b.status)) return res.json({ status: b.status, ready: false });
  const media = await query(
    `select phase, bike_number, mime_type, size_bytes, created_at from booking_media
      where booking_id = $1 and phase in ('pickup', 'return') order by created_at`, [b.id]);
  res.json({
    ready: true,
    status: b.status,
    name: b.customer_name.split(' ')[0],
    start: b.start_date, end: b.end_date, days: b.days,
    ridingArea: site.ridingArea,
    delivery: b.delivery, collection: b.collection, address: b.delivery || b.collection ? b.customer_address : null,
    pickupFromTime: site.pickupFromTime, returnByTime: site.returnByTime, pickupAddress: site.pickupAddress,
    bikes: await bikesFor(b.id),
    media: media.map((m) => ({ phase: m.phase, bike: m.bike_number, kind: m.mime_type.startsWith('video/') ? 'video' : 'photo', size: m.size_bytes, at: m.created_at })),
    windows: tripWindows(b),
    today: todayLocal(),
    maxFileBytes: MAX_TRIP_FILE_BYTES,
    phone: business.phone,
  });
});

// POST /api/trip/media?t=&phase=pickup|return&bike=N  (body = the raw video/photo file)
r.post('/trip/media', rateLimit({ windowMs: 60 * 60 * 1000, max: 60 }), async (req, res) => {
  const refuse = (status, error) => { req.resume(); res.status(status).json({ error }); };
  const b = await findTrip(req.query.t);
  if (!b) return refuse(404, 'Booking not found.');
  const phase = req.query.phase;
  if (!['pickup', 'return'].includes(phase)) return refuse(400, 'Unknown upload type.');
  const w = tripWindows(b);
  if (!w[phase]) {
    return refuse(400, phase === 'pickup'
      ? 'Pickup videos can be added from the day before your hire until the return day.'
      : 'Return videos can be added from your pickup day until a week after your return day.');
  }
  const bikeNumber = Number(req.query.bike);
  const bikes = await bikesFor(b.id);
  if (!bikes.some((bk) => bk.number === bikeNumber)) return refuse(400, 'That scooter is not part of this booking.');
  const declared = Number(req.get('content-length') || 0);
  if (declared > MAX_TRIP_FILE_BYTES) return refuse(413, 'That file is too big. Please record a shorter video (about 1 minute).');
  const [{ used }] = await query(`select coalesce(sum(size_bytes), 0) as used from booking_media where booking_id = $1 and phase in ('pickup', 'return')`, [b.id]);
  const room = MAX_TRIP_BYTES_PER_BOOKING - used;
  if (room <= 0 || declared > room) return refuse(413, `You've uploaded a lot already — that's plenty for us. If something is missing, call us on ${business.phone}.`);

  let saved;
  try {
    saved = await saveTripUpload(req, { bookingId: b.id, phase, bikeNumber, maxBytes: Math.min(MAX_TRIP_FILE_BYTES, room) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[trip] upload failed:', err.message);
    return res.status(500).json({ error: 'The upload failed. Please try again.' });
  }
  await query(
    `insert into booking_media (booking_id, phase, bike_number, file_path, mime_type, size_bytes) values ($1, $2, $3, $4, $5, $6)`,
    [b.id, phase, bikeNumber, saved.relPath, saved.mime, saved.size]);
  // First pickup video = the customer has the scooter. (Return is marked by you in the admin page,
  // so an early "return" upload can never free the scooter for someone else.)
  if (phase === 'pickup') await query(`update bookings set status = 'active', updated_at = now() where id = $1 and status = 'confirmed'`, [b.id]);
  console.log(`[trip] ${b.id.slice(0, 8)} ${phase} ${saved.kind} for Bike ${bikeNumber} (${Math.round(saved.size / 1e6)} MB)`);
  res.status(201).json({ ok: true, kind: saved.kind, size: saved.size });
});

export default r;
