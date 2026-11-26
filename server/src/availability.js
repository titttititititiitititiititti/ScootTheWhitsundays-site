import { query } from './db.js';

// Bookings that block a bike: paid / in progress, or an unpaid checkout that
// hasn't expired yet. Date ranges are inclusive on both ends, so a bike
// returned on the 5th can't be picked up by someone else on the 5th.
const ACTIVE_BOOKING = `
  (b.status in ('awaiting_bond', 'confirmed', 'active')
   or (b.status = 'pending_payment' and b.pending_expires_at > now()))`;

// True when bikes.id is booked, blocked in the admin page, or on a long-term rental at any point between $1 and $2.
const BIKE_BUSY = `(exists (
  select 1 from booking_bikes bb join bookings b on b.id = bb.booking_id
   where bb.bike_id = bikes.id
     and b.start_date <= $2::date and b.end_date >= $1::date
     and ${ACTIVE_BOOKING})
  or exists (
  select 1 from bike_blocks bl
   where bl.bike_id = bikes.id
     and bl.start_date <= $2::date and coalesce(bl.end_date, 'infinity'::date) >= $1::date)
  or exists (
  select 1 from long_term_rentals lt
   where lt.bike_id = bikes.id
     and lt.start_date <= $2::date and coalesce(lt.end_date, 'infinity'::date) >= $1::date))`;

/** Public info for bikes free for the WHOLE [start, end] range. */
export async function availableBikes(start, end, q = query) {
  return q(
    `select bikes.id, bikes.number, bikes.name, bikes.photo, bikes.needs_motorcycle_licence
       from bikes
      where bikes.status = 'available' and not ${BIKE_BUSY}
      order by bikes.number`,
    [start, end],
  );
}

/** Which of these bikes are free for the range (call inside a transaction after locking them). */
export async function freeBikeIds(bikeIds, start, end, q = query) {
  const rows = await q(
    `select bikes.id from bikes
      where bikes.id = any($3::int[]) and bikes.status = 'available' and not ${BIKE_BUSY}`,
    [start, end, bikeIds],
  );
  return rows.map((r) => r.id);
}

/** Number of bikes free on each day from..to: [{ date, free }]. */
export async function freePerDay(from, to, q = query) {
  return q(
    `select to_char(d, 'YYYY-MM-DD') as date,
            (select count(*) from bikes
              where bikes.status = 'available'
                and not exists (
                  select 1 from booking_bikes bb join bookings b on b.id = bb.booking_id
                   where bb.bike_id = bikes.id
                     and b.start_date <= d::date and b.end_date >= d::date
                     and ${ACTIVE_BOOKING})
                and not exists (
                  select 1 from bike_blocks bl
                   where bl.bike_id = bikes.id
                     and bl.start_date <= d::date and coalesce(bl.end_date, 'infinity'::date) >= d::date)
                and not exists (
                  select 1 from long_term_rentals lt
                   where lt.bike_id = bikes.id
                     and lt.start_date <= d::date and coalesce(lt.end_date, 'infinity'::date) >= d::date)) as free
       from generate_series($1::date, $2::date, interval '1 day') as d
      order by d`,
    [from, to],
  );
}

/** Every scooter and whether it's free today, for the home page's "Currently booked" badges.
 *  Only names and a yes/no: never why it's busy or who has it. */
export async function fleetToday(today, q = query) {
  return q(
    `select bikes.name, (bikes.status = 'available' and not ${BIKE_BUSY}) as free
       from bikes order by bikes.number`,
    [today, today],
  );
}

/** Scooters in the fleet (not retired): the most anyone can pick in step 1. The calendar shows what is actually free. */
export async function fleetSize(q = query) {
  return (await q(`select count(*) as n from bikes where status = 'available'`))[0].n;
}
