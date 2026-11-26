// Prices you can change from the admin page. Stored in the database (settings
// table) and kept in memory, so quotes stay instant. Changing them only affects
// NEW bookings — every booking stores the exact amount the customer paid.
import { query } from './db.js';
import { pricing as defaults } from './config.js';

const DEFAULT_PRICING = {
  dailyRate: defaults.dailyRate,
  oneDayExtra: defaults.oneDayExtra,
  weeklyRate: defaults.weeklyRate,
  deliveryFee: defaults.deliveryFee,
};
let current = { ...DEFAULT_PRICING };

export const getPricing = () => ({ ...current });

/** Loads saved prices (call once at startup, after migrations). */
export async function loadSettings() {
  const [row] = await query(`select value from settings where key = 'pricing'`);
  current = { ...DEFAULT_PRICING, ...(row?.value || {}) };
  return getPricing();
}

/** Validates and saves new prices (all in cents). Returns { pricing } or { error }. */
export async function savePricing(input) {
  const next = { ...current };
  for (const k of ['dailyRate', 'oneDayExtra', 'weeklyRate', 'deliveryFee']) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    if (!Number.isInteger(v) || v < 0 || v > 100000) return { error: 'Prices must be whole amounts between $0 and $1000.' };
    next[k] = v;
  }
  if (next.dailyRate < 100) return { error: 'The daily rate must be at least $1.' };
  if (next.weeklyRate && next.weeklyRate < next.dailyRate) return { error: 'The weekly price can’t be less than one day.' };
  await query(
    `insert into settings (key, value) values ('pricing', $1::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`, [JSON.stringify(next)]);
  current = next;
  return { pricing: getPricing() };
}

/** Tests only. */
export function setPricingForTests(p) { current = { ...DEFAULT_PRICING, ...p }; }
