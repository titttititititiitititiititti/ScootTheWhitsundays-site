// Long-term rentals you arrange yourself: a weekly price, a start day, and a
// "paid" tick for each week. Rent is due on the start day and every 7 days
// after (paid in advance). While a rental is on, the scooter can't be booked online.
import { query } from './db.js';
import { todayLocal, dayDiff } from './pricing.js';
import { booking as site, longTerm as cfg } from './config.js';
import { sendEmail, escapeHtml as h } from './email.js';

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const fmt = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Every rent day from the start up to `upTo` (and before the rental ended). */
export function dueDates(rental, upTo) {
  const out = [];
  for (let d = rental.start_date; d <= upTo; d = addDays(d, 7)) {
    if (rental.end_date && d > rental.end_date) break;
    if (rental.end_date && d === rental.end_date && d !== rental.start_date) break; // returned on a rent day: no new week
    out.push(d);
  }
  return out;
}

/** Weeks owed (due on or before today, not paid) and the next unpaid rent day after today. */
export function rentStatus(rental, paidDates, today = todayLocal()) {
  const paid = new Set(paidDates);
  const owed = dueDates(rental, today).filter((d) => !paid.has(d));
  let next = null;
  for (const d of dueDates(rental, addDays(today, 7 * 60))) {
    if (d > today && !paid.has(d)) { next = d; break; }
  }
  return { owed, next };
}

/** Running rentals, plus ones ended in the last 90 days (so unpaid weeks still show), with payments. */
export async function currentRentals(today = todayLocal()) {
  const rentals = await query(
    `select r.*, to_char(r.start_date, 'YYYY-MM-DD') as start_date, to_char(r.end_date, 'YYYY-MM-DD') as end_date,
            bikes.number as bike_number, bikes.name as bike_name
       from long_term_rentals r join bikes on bikes.id = r.bike_id
      where r.end_date is null or r.end_date >= $1::date - 90  -- ended rentals stay listed while weeks are unpaid
      order by bikes.number`, [today]);
  const pays = rentals.length ? await query(
    `select rental_id, to_char(due_date, 'YYYY-MM-DD') as due_date, amount from long_term_payments
      where rental_id = any($1::int[]) and paid_at is not null`, [rentals.map((r) => r.id)]) : [];
  return rentals.map((r) => {
    const paid = pays.filter((p) => p.rental_id === r.id);
    const st = rentStatus(r, paid.map((p) => p.due_date), today);
    return { ...r, paidWeeks: paid.length, totalPaid: paid.reduce((s, p) => s + p.amount, 0), owed: st.owed, nextDue: st.next };
  });
}

export async function markPaid(rentalId, dueDate) {
  const [r] = await query(`select *, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date from long_term_rentals where id = $1`, [rentalId]);
  if (!r) return { error: 'Rental not found.', status: 404 };
  // Must be one of this rental's rent days (any time up to 8 weeks ahead).
  const days = dueDates(r, addDays(todayLocal(), 56));
  if (!days.includes(dueDate)) return { error: 'That isn’t a rent day for this rental.', status: 400 };
  await query(
    `insert into long_term_payments (rental_id, due_date, amount, paid_at) values ($1, $2, $3, now())
     on conflict (rental_id, due_date) do update set paid_at = now(), amount = excluded.amount`, [r.id, dueDate, r.weekly_rate]);
  return { ok: true };
}

export async function unmarkPaid(rentalId, dueDate) {
  await query(`update long_term_payments set paid_at = null where rental_id = $1 and due_date = $2`, [rentalId, dueDate]);
  return { ok: true };
}

const brisbaneHour = (now) => Number(new Intl.DateTimeFormat('en-AU', { timeZone: site.timezone, hour: 'numeric', hourCycle: 'h23' }).format(now));

/** Emails you once per rent day that isn't marked paid by the reminder hour. */
export async function sendRentReminders(now = new Date()) {
  if (brisbaneHour(now) < cfg.reminderHour) return 0;
  if (!process.env.OWNER_NOTIFY_EMAIL && process.env.RESEND_API_KEY) return 0;
  const today = todayLocal(now);
  const rentals = await currentRentals(today);
  const dueToday = rentals.filter((r) => r.owed.includes(today));
  let sent = 0;
  for (const r of dueToday) {
    // Claim the reminder for today (once only, even if two sweeps overlap).
    const claim = await query(
      `insert into long_term_payments (rental_id, due_date, amount, reminder_sent_at) values ($1, $2, $3, now())
       on conflict (rental_id, due_date) do update set reminder_sent_at = now()
         where long_term_payments.reminder_sent_at is null and long_term_payments.paid_at is null
       returning id`, [r.id, today, r.weekly_rate]);
    if (!claim.length) continue;
    const earlier = r.owed.filter((d) => d < today);
    const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    try {
      await sendEmail({
        to: process.env.OWNER_NOTIFY_EMAIL || '(OWNER_NOTIFY_EMAIL not set)',
        subject: `Rent due today: Bike ${r.bike_number} – ${r.renter_name} – ${money(r.weekly_rate)}`,
        html: `<p style="font-size:16px"><b>${h(r.renter_name)}</b>'s weekly rent for <b>Bike ${r.bike_number}</b> (${h(r.bike_name)}) is due today: <b>${money(r.weekly_rate)}</b>.</p>
${r.renter_phone ? `<p>Phone: <a href="tel:${h(r.renter_phone.replace(/\s/g, ''))}">${h(r.renter_phone)}</a></p>` : ''}
${earlier.length ? `<p style="color:#8b2a2a"><b>Also not marked paid:</b> ${earlier.map(fmt).join(', ')} (${money(earlier.length * r.weekly_rate)}).</p>` : ''}
<p>Once you've received it, mark it paid in the <a href="${base}/admin">admin page</a> → Bookings → Rent due.</p>`,
        text: `${r.renter_name}'s weekly rent for Bike ${r.bike_number} is due today: ${money(r.weekly_rate)}.${earlier.length ? ` Also unpaid: ${earlier.join(', ')}.` : ''} Mark it paid at ${base}/admin`,
        idempotencyKey: `rent-due-${r.id}-${today}`,
      });
      sent++;
    } catch (err) {
      console.error(`[rent] reminder for rental ${r.id} failed: ${err.message}`);
      await query(`update long_term_payments set reminder_sent_at = null where rental_id = $1 and due_date = $2`, [r.id, today]).catch(() => {});
    }
  }
  return sent;
}

export function startRentReminderSweep(everyMs = 15 * 60 * 1000) {
  const run = () => sendRentReminders().catch((e) => console.error('[rent] sweep:', e.message));
  setTimeout(run, 20 * 1000).unref();
  const t = setInterval(run, everyMs);
  t.unref();
  return t;
}

