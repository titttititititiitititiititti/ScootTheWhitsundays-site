import { Router } from 'express';
import { pricing, bond, booking } from '../config.js';
import { quote, isIsoDate, todayLocal, dayDiff } from '../pricing.js';
import { getPricing } from '../settings.js';
import { availableBikes, freePerDay, fleetSize, fleetToday } from '../availability.js';

const r = Router();

r.get('/health', (_req, res) => res.json({ ok: true }));

// Prices for display on the booking page (single source of truth = config.js)
r.get('/config', async (_req, res) => {
  res.json({
    pricing: {
      currency: pricing.currency,
      ...getPricing(),
      countBothEnds: pricing.countBothEnds,
      maxHireDays: pricing.maxHireDays,
    },
    bond: { amount: bond.amount, holdIfReturnWithinDays: bond.holdIfReturnWithinDays },
    pickup: { fromTime: booking.pickupFromTime, returnByTime: booking.returnByTime },
    fleetSize: await fleetSize(),
    today: todayLocal(),
  });
});

// GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD → how many scooters are free each day
r.get('/calendar', async (req, res) => {
  const today = todayLocal();
  let from = String(req.query.from || today);
  let to = String(req.query.to || '');
  if (!isIsoDate(from) || !isIsoDate(to)) return res.status(400).json({ error: 'Invalid dates.' });
  if (from < today) from = today;
  if (to < from) return res.json({ days: [] });
  if (dayDiff(from, to) > 92) return res.status(400).json({ error: 'Range too long.' });
  res.json({ days: await freePerDay(from, to) });
});

// GET /api/fleet-today â†’ [{ name, free }] for the home page's "Currently booked" badges
r.get('/fleet-today', async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ bikes: await fleetToday(todayLocal()) });
});

// GET /api/availability?start=&end=&count=→ quote + bikes free for the whole period
r.get('/availability', async (req, res) => {
  const q = quote(String(req.query.start || ''), String(req.query.end || ''), req.query.count || 1, new Date(), tripOpts(req.query));
  if (q.error) return res.status(400).json({ error: q.error });
  const bikes = await availableBikes(q.start, q.end);
  res.json({ quote: q, bikes, enough: bikes.length >= q.count });
});

/** ?delivery=1&collection=1 → { delivery, collection } */
export function tripOpts(qs) {
  return { delivery: qs.delivery === '1' || qs.delivery === true, collection: qs.collection === '1' || qs.collection === true };
}

export default r;
