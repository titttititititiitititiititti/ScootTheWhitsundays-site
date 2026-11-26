import { pricing, bond, booking } from './config.js';
import { getPricing } from './settings.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today's date (YYYY-MM-DD) in the business timezone. */
export function todayLocal(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: booking.timezone }).format(now);
}

/** Whole days from a to b (b - a), both YYYY-MM-DD. */
export function dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function hireDays(start, end) {
  const diff = dayDiff(start, end);
  return Math.max(1, pricing.countBothEnds ? diff + 1 : diff);
}

/** Rent in cents per scooter for a number of days, using the current prices (admin page). */
export function rentFor(days, p = getPricing()) {
  if (days === 1) {
    const one = p.dailyRate + p.oneDayExtra;
    return { weeks: 0, extraDays: 1, perDay: one, rent: one };
  }
  if (p.weeklyRate > 0 && days >= 7) {
    const weeks = Math.floor(days / 7);
    const extraDays = days % 7;
    // Extra days never cost more than another week.
    const extra = Math.min(extraDays * p.dailyRate, p.weeklyRate);
    return { weeks, extraDays, perDay: p.dailyRate, rent: weeks * p.weeklyRate + extra };
  }
  return { weeks: 0, extraDays: days, perDay: p.dailyRate, rent: days * p.dailyRate };
}

/**
 * Validates the dates and returns a full quote for `count` scooters, or { error }.
 * opts.delivery / opts.collection: we bring the scooters at the start / collect them at the end.
 */
export function quote(start, end, count = 1, now = new Date(), opts = {}) {
  count = Number(count);
  if (!Number.isInteger(count) || count < 1 || count > 20) return { error: 'Please choose how many scooters you need.' };
  if (!isIsoDate(start) || !isIsoDate(end)) return { error: 'Please choose valid dates.' };
  const today = todayLocal(now);
  if (start < today) return { error: 'Start date is in the past.' };
  if (end < start) return { error: 'End date is before the start date.' };
  const days = hireDays(start, end);
  if (days > pricing.maxHireDays) {
    return { error: `Online bookings are limited to ${pricing.maxHireDays} days — please contact us for longer hires.` };
  }
  const p = getPricing();
  const r = rentFor(days, p);
  const delivery = Boolean(opts.delivery), collection = Boolean(opts.collection);
  const deliveryEach = p.deliveryFee * (Number(delivery) + Number(collection));
  const bondMethod = dayDiff(today, end) <= bond.holdIfReturnWithinDays ? 'hold' : 'charge';
  return {
    start, end, days, count,
    weeks: r.weeks, extraDays: r.extraDays, perDay: r.perDay,
    rentEach: r.rent,
    rent: r.rent * count,          // total for all scooters
    bondEach: bond.amount,
    bond: bond.amount * count,     // total for all scooters
    bondMethod,
    delivery, collection,
    deliveryFee: p.deliveryFee,          // per scooter per trip
    deliveryEach,                        // per scooter, both trips chosen
    deliveryTotal: deliveryEach * count,
    currency: pricing.currency,
  };
}
