// Admin API (behind the PIN): bookings, scooter availability, prices, income.
import { Router } from 'express';
import path from 'node:path';
import { query } from '../db.js';
import { todayLocal, isIsoDate } from '../pricing.js';
import { getPricing, savePricing } from '../settings.js';
import { uploadsRoot } from '../uploads.js';
import { adminEnabled, checkPin, isAdmin, startSession, endSession, requireAdmin } from '../adminAuth.js';
import { currentRentals, markPaid, unmarkPaid } from '../longTerm.js';
import { clientIp } from '../rateLimit.js';
import { stats as visitorStats, recentPriceChecks } from '../visitors.js';

const r = Router();
const PAID = `('confirmed', 'active', 'returned', 'bond_released')`;

// ── Login (limited per device and overall, so a 4-digit PIN can't be guessed) ──
const fails = new Map(); // ip -> [timestamps]
let globalFails = [];
const WINDOW = 15 * 60 * 1000;
function tooMany(ip, now) {
  const mine = (fails.get(ip) || []).filter((t) => now - t < WINDOW);
  globalFails = globalFails.filter((t) => now - t < 60 * 60 * 1000);
  return mine.length >= 5 || globalFails.length >= 30;
}
export function resetLoginLimitsForTests() { fails.clear(); globalFails = []; }

r.get('/status', (req, res) => res.json({ enabled: adminEnabled(), loggedIn: isAdmin(req) }));

r.post('/login', (req, res) => {
  if (!adminEnabled()) return res.status(503).json({ error: 'Admin is switched off: set ADMIN_PIN on the server.' });
  const now = Date.now();
  if (tooMany(clientIp(req), now)) return res.status(429).json({ error: 'Too many wrong PINs. Try again in 15 minutes.' });
  if (!checkPin(String(req.body?.pin ?? ''))) {
    fails.set(clientIp(req), [...(fails.get(clientIp(req)) || []).filter((t) => now - t < WINDOW), now]);
    globalFails.push(now);
    console.warn(`[admin] wrong PIN from ${clientIp(req)}`);
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  fails.delete(clientIp(req));
  startSession(req, res);
  res.json({ ok: true });
});

r.post('/logout', (req, res) => { endSession(req, res); res.json({ ok: true }); });

r.use(requireAdmin);

// ── Everything the admin page shows ──
r.get('/overview', async (_req, res) => {
  const today = todayLocal();
  const monthStart = today.slice(0, 8) + '01';
  const bikes = await query(`select id, number, name, photo, status, needs_motorcycle_licence from bikes where status <> 'retired' order by number`);
  const blocks = await query(`select id, bike_id, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, reason
                                from bike_blocks where end_date is null or end_date >= $1::date order by start_date`, [today]);
  // Each scooter's share of a booking's rent (bookings can have several scooters).
  const income = await query(
    `select bb.bike_id,
            count(*) as hires,
            sum(b.days) as days,
            sum(b.rent_amount / b.scooter_count) as all_time,
            sum(case when b.start_date >= $1::date then b.rent_amount / b.scooter_count else 0 end) as this_month
       from booking_bikes bb join bookings b on b.id = bb.booking_id
      where b.status in ${PAID} and b.paid_at is not null
      group by bb.bike_id`, [monthStart]);
  const bookings = await query(
    `select b.id, b.customer_name, b.customer_phone, b.customer_email, b.start_date, b.end_date, b.days,
            b.status, b.bond_status, b.bond_method, b.rent_amount, b.bond_amount, b.created_at,
            b.delivery, b.collection, b.delivery_amount, b.customer_address,
            (select array_agg(bk.number order by bk.number) from booking_bikes bb join bikes bk on bk.id = bb.bike_id where bb.booking_id = b.id) as bikes,
            (select count(*) from booking_media m where m.booking_id = b.id and m.phase = 'pickup') as pickup_media,
            (select count(*) from booking_media m where m.booking_id = b.id and m.phase = 'return') as return_media
       from bookings b
      where (b.status in ${PAID} or b.status = 'awaiting_bond')
        and b.end_date >= $1::date - 14
      order by b.start_date, b.created_at`, [today]);
  const ltIncome = await query(
    `select r.bike_id,
            sum(p.amount) as all_time,
            sum(case when p.due_date >= $1::date then p.amount else 0 end) as this_month,
            count(*) as weeks
       from long_term_payments p join long_term_rentals r on r.id = p.rental_id
      where p.paid_at is not null
      group by r.bike_id`, [monthStart]);
  const [deliv] = await query(
    `select coalesce(sum(delivery_amount), 0) as all_time,
            coalesce(sum(case when start_date >= $1::date then delivery_amount else 0 end), 0) as this_month
       from bookings where status in ${PAID} and paid_at is not null`, [monthStart]);
  const rentals = await currentRentals(today);
  const byBike = new Map(income.map((i) => [i.bike_id, i]));
  const ltByBike = new Map(ltIncome.map((i) => [i.bike_id, i]));
  res.json({
    today,
    pricing: getPricing(),
    delivery: { allTime: deliv.all_time, thisMonth: deliv.this_month },
    longTermWeekly: rentals.filter((x) => !x.end_date && x.start_date <= today).reduce((sum, x) => sum + x.weekly_rate, 0),
    rentDue: rentals.flatMap((x) => x.owed.map((d) => ({
      rentalId: x.id, dueDate: d, amount: x.weekly_rate, renter: x.renter_name, phone: x.renter_phone, bike: x.bike_number,
    }))).sort((a, c) => a.dueDate.localeCompare(c.dueDate)),
    bikes: bikes.map((b) => {
      const i = byBike.get(b.id);
      const bikeBlocks = blocks.filter((x) => x.bike_id === b.id);
      const blockedToday = bikeBlocks.find((x) => x.start_date <= today && (!x.end_date || x.end_date >= today));
      const lt = rentals.find((x) => x.bike_id === b.id && !x.end_date && x.start_date <= today);
      const ltLater = rentals.find((x) => x.bike_id === b.id && !x.end_date && x.start_date > today);
      const rental = lt || ltLater;
      const li = ltByBike.get(b.id);
      const bookedToday = bookings.find((x) => x.start_date <= today && x.end_date >= today && (x.bikes || []).includes(b.number));
      return {
        id: b.id, number: b.number, name: b.name, photo: b.photo, needsMotorcycleLicence: b.needs_motorcycle_licence,
        blocks: bikeBlocks.map((x) => ({ id: x.id, start: x.start_date, end: x.end_date, reason: x.reason })),
        longTerm: rental ? {
          id: rental.id, renter: rental.renter_name, phone: rental.renter_phone, weeklyRate: rental.weekly_rate,
          start: rental.start_date, end: rental.end_date, owed: rental.owed, nextDue: rental.nextDue,
          paidWeeks: rental.paidWeeks, totalPaid: rental.totalPaid,
        } : null,
        today: lt ? { state: 'longterm', name: lt.renter_name }
          : blockedToday ? { state: 'blocked', reason: blockedToday.reason, until: blockedToday.end_date }
          : bookedToday ? { state: 'booked', name: bookedToday.customer_name, until: bookedToday.end_date }
          : { state: 'free' },
        income: {
          hires: i?.hires || 0, days: i?.days || 0, allTime: i?.all_time || 0, thisMonth: i?.this_month || 0,
          longTermAllTime: li?.all_time || 0, longTermThisMonth: li?.this_month || 0, longTermWeeks: li?.weeks || 0,
        },
      };
    }),
    bookings: bookings.map((b) => ({
      id: b.id, name: b.customer_name, phone: b.customer_phone, email: b.customer_email,
      start: b.start_date, end: b.end_date, days: b.days, bikes: b.bikes || [],
      status: b.status, bondStatus: b.bond_status, bondMethod: b.bond_method,
      rent: b.rent_amount, bond: b.bond_amount, pickupMedia: b.pickup_media, returnMedia: b.return_media,
      delivery: b.delivery, collection: b.collection, deliveryAmount: b.delivery_amount, address: b.customer_address,
    })),
  });
});

// ── One booking in full (licence details, photos, videos) ──
// GET /visitors?days=1|7|30 → funnel, sources, hire lengths and recent price checks
r.get('/visitors', async (req, res) => {
  const days = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 1;
  const today = todayLocal();
  const from = new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  const [s, recent] = await Promise.all([visitorStats(from, today), recentPriceChecks(from, today)]);
  res.json({ days, ...s, recent });
});

r.get('/bookings/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const [b] = await query('select * from bookings where id = $1', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const media = await query(
    `select id, phase, bike_number, mime_type, size_bytes, created_at from booking_media where booking_id = $1 order by phase, created_at`, [b.id]);
  res.json({
    id: b.id, name: b.customer_name, email: b.customer_email, phone: b.customer_phone, dob: b.customer_dob,
    address: b.customer_address, licence: { type: b.licence_type, number: b.licence_number, country: b.licence_country, expiry: b.licence_expiry, over12Months: b.licence_12_months },
    accidents: b.at_fault_accidents, accidentDetails: b.accident_details, restrictions: b.driving_restrictions, restrictionDetails: b.restriction_details,
    signature: b.signature_name, signedAt: b.agreement_signed_at,
    media: media.map((m) => ({ id: m.id, phase: m.phase, bike: m.bike_number, mime: m.mime_type, size: m.size_bytes, at: m.created_at })),
  });
});

// Private files: only ever sent to a logged-in admin.
r.get('/media/:id', async (req, res) => {
  const [m] = await query('select file_path, mime_type from booking_media where id = $1', [Number(req.params.id) || 0]);
  if (!m) return res.status(404).end();
  const root = path.resolve(uploadsRoot());
  const file = path.resolve(root, m.file_path);
  if (!file.startsWith(root + path.sep)) return res.status(404).end();
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': m.mime_type });
  res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ── Prices (dollars in, cents stored) ──
r.put('/pricing', async (req, res) => {
  const cents = (v) => (v === undefined ? undefined : v === null || v === '' ? 0 : Math.round(Number(v) * 100));
  const body = req.body || {};
  const out = await savePricing({
    dailyRate: cents(body.dailyRate), oneDayExtra: cents(body.oneDayExtra), weeklyRate: cents(body.weeklyRate), deliveryFee: cents(body.deliveryFee),
  });
  if (out.error) return res.status(400).json(out);
  console.log(`[admin] prices changed: $${out.pricing.dailyRate / 100}/day, +$${out.pricing.oneDayExtra / 100} for one day, week ${out.pricing.weeklyRate ? '$' + out.pricing.weeklyRate / 100 : 'off'}, delivery $${out.pricing.deliveryFee / 100}/trip`);
  res.json(out);
});

// ── Scooters ──
const cleanName = (s) => (typeof s === 'string' ? s.trim().slice(0, 80) : '');

r.post('/bikes', async (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Please give the scooter a name.' });
  const [{ next }] = await query('select coalesce(max(number), 0) + 1 as next from bikes');
  const [bike] = await query(
    `insert into bikes (number, name, needs_motorcycle_licence) values ($1, $2, $3) returning id, number, name`,
    [next, name, Boolean(req.body?.needsMotorcycleLicence)]);
  res.status(201).json({ bike });
});

r.patch('/bikes/:id', async (req, res) => {
  const id = Number(req.params.id);
  const sets = [], vals = [id];
  if (req.body?.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Please give the scooter a name.' });
    vals.push(name); sets.push(`name = $${vals.length}`);
  }
  if (req.body?.needsMotorcycleLicence !== undefined) { vals.push(Boolean(req.body.needsMotorcycleLicence)); sets.push(`needs_motorcycle_licence = $${vals.length}`); }
  if (req.body?.retired !== undefined) { vals.push(req.body.retired ? 'retired' : 'available'); sets.push(`status = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  const rows = await query(`update bikes set ${sets.join(', ')}, updated_at = now() where id = $1 returning id`, vals);
  if (!rows.length) return res.status(404).json({ error: 'Scooter not found.' });
  res.json({ ok: true });
});

// Make a scooter unavailable for some dates (end = null → until you remove it).
r.post('/bikes/:id/blocks', async (req, res) => {
  const id = Number(req.params.id);
  const start = String(req.body?.start || '');
  const end = req.body?.end ? String(req.body.end) : null;
  const reason = cleanName(req.body?.reason) || 'Unavailable';
  if (!isIsoDate(start) || (end && !isIsoDate(end))) return res.status(400).json({ error: 'Please choose valid dates.' });
  if (end && end < start) return res.status(400).json({ error: 'The end date is before the start date.' });
  const [bike] = await query('select id, number from bikes where id = $1', [id]);
  if (!bike) return res.status(404).json({ error: 'Scooter not found.' });
  const [block] = await query(
    `insert into bike_blocks (bike_id, start_date, end_date, reason) values ($1, $2, $3, $4) returning id`, [id, start, end, reason]);
  // Paid bookings already on those dates stay booked — tell the owner so they can sort it out.
  const conflicts = await query(
    `select b.customer_name as name, b.customer_phone as phone, b.start_date as start, b.end_date as end
       from bookings b join booking_bikes bb on bb.booking_id = b.id
      where bb.bike_id = $1 and b.status in ${PAID}
        and b.start_date <= coalesce($3::date, 'infinity'::date) and b.end_date >= $2::date
      order by b.start_date`, [id, start, end]);
  res.status(201).json({ id: block.id, conflicts });
});

r.delete('/blocks/:id', async (req, res) => {
  const rows = await query('delete from bike_blocks where id = $1 returning id', [Number(req.params.id) || 0]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Long-term rentals ──
const dollars = (v) => Math.round(Number(v) * 100);

r.post('/bikes/:id/long-term', async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const renter = cleanName(body.renterName);
  const phone = typeof body.renterPhone === 'string' ? body.renterPhone.trim().slice(0, 40) : '';
  const weekly = dollars(body.weeklyRate);
  const start = String(body.start || '');
  if (!renter) return res.status(400).json({ error: 'Please enter who is renting it.' });
  if (!Number.isInteger(weekly) || weekly <= 0 || weekly > 500000) return res.status(400).json({ error: 'Please enter the weekly price.' });
  if (!isIsoDate(start)) return res.status(400).json({ error: 'Please choose the day they started.' });
  const [bike] = await query('select id from bikes where id = $1', [id]);
  if (!bike) return res.status(404).json({ error: 'Scooter not found.' });
  const [clash] = await query(
    `select id from long_term_rentals where bike_id = $1 and coalesce(end_date, 'infinity'::date) >= $2::date`, [id, start]);
  if (clash) return res.status(400).json({ error: 'This scooter already has a long-term rental. End that one first.' });
  const [row] = await query(
    `insert into long_term_rentals (bike_id, renter_name, renter_phone, weekly_rate, start_date) values ($1, $2, $3, $4, $5) returning id`,
    [id, renter, phone || null, weekly, start]);
  const conflicts = await query(
    `select b.customer_name as name, b.customer_phone as phone, b.start_date as start, b.end_date as end
       from bookings b join booking_bikes bb on bb.booking_id = b.id
      where bb.bike_id = $1 and b.status in ${PAID} and b.end_date >= $2::date order by b.start_date`, [id, start]);
  res.status(201).json({ id: row.id, conflicts });
});

r.patch('/long-term/:id', async (req, res) => {
  const body = req.body || {};
  const sets = [], vals = [Number(req.params.id) || 0];
  if (body.weeklyRate !== undefined) {
    const w = dollars(body.weeklyRate);
    if (!Number.isInteger(w) || w <= 0 || w > 500000) return res.status(400).json({ error: 'Please enter the weekly price.' });
    vals.push(w); sets.push(`weekly_rate = $${vals.length}`);
  }
  if (body.renterName !== undefined) {
    const n = cleanName(body.renterName);
    if (!n) return res.status(400).json({ error: 'Please enter who is renting it.' });
    vals.push(n); sets.push(`renter_name = $${vals.length}`);
  }
  if (body.renterPhone !== undefined) { vals.push(String(body.renterPhone).trim().slice(0, 40) || null); sets.push(`renter_phone = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  const rows = await query(`update long_term_rentals set ${sets.join(', ')} where id = $1 returning id`, vals);
  if (!rows.length) return res.status(404).json({ error: 'Rental not found.' });
  res.json({ ok: true });
});

// The scooter came back: the rental ends (that day) and it can be booked online again after.
r.post('/long-term/:id/end', async (req, res) => {
  const end = req.body?.end ? String(req.body.end) : todayLocal();
  if (!isIsoDate(end)) return res.status(400).json({ error: 'Please choose a valid date.' });
  const rows = await query(
    `update long_term_rentals set end_date = greatest($2::date, start_date) where id = $1 and end_date is null returning id`,
    [Number(req.params.id) || 0, end]);
  if (!rows.length) return res.status(404).json({ error: 'Rental not found or already ended.' });
  res.json({ ok: true });
});

r.post('/long-term/:id/paid', async (req, res) => {
  const due = String(req.body?.dueDate || '');
  if (!isIsoDate(due)) return res.status(400).json({ error: 'Invalid date.' });
  const id = Number(req.params.id) || 0;
  const out = req.body?.undo ? await unmarkPaid(id, due) : await markPaid(id, due);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({ ok: true });
});

export default r;
