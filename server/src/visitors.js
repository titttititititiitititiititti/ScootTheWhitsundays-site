// Visitor stats + price-check alerts, so you can see whether prices put people off.
//
// Privacy: no cookies, no IP addresses, no names. Each visitor is a one-way hash of
// (secret, today's date, IP, browser) that changes every day. Bots are ignored, and
// so are you while you're logged into the admin page.
//
// Emails to OWNER_NOTIFY_EMAIL:
//  • "Someone checked prices" — once per visitor per day, sent a few minutes after
//    they stop looking, saying what they looked at and whether they went to payment.
//    Capped per day so a busy day (or a bot) can't use up your Resend allowance.
//  • An evening summary of the day.
import crypto from 'node:crypto';
import { query } from './db.js';
import { sendEmail, escapeHtml as h } from './email.js';
import { todayLocal } from './pricing.js';
import { booking as site, visitorStats as cfg } from './config.js';
import { isAdmin } from './adminAuth.js';
import { clientIp } from './rateLimit.js';

const PAID = `('awaiting_bond', 'confirmed', 'active', 'returned', 'bond_released')`;
const KINDS = new Set(['visit', 'book_open', 'price_seen', 'checkout']);
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|node-fetch|axios|go-http|java\/|okhttp|httpclient|render/i;

const money = (c) => `$${(Number(c) / 100).toFixed(Number(c) % 100 ? 2 : 0)}`;
const fmt = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const hourIn = (now) => Number(new Intl.DateTimeFormat('en-AU', { timeZone: site.timezone, hour: 'numeric', hourCycle: 'h23' }).format(now));
const timeIn = (d) => new Date(d).toLocaleTimeString('en-AU', { timeZone: site.timezone, hour: 'numeric', minute: '2-digit' });
const baseUrl = () => (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const plural = (n, w) => `${n} ${w}${Number(n) === 1 ? '' : 's'}`;

export function isBot(ua) {
  return !ua || BOT_UA.test(ua);
}

/** Daily-rotating anonymous id. */
export function visitorId(req, day) {
  const secret = process.env.SESSION_SECRET || 'local-dev';
  return crypto.createHash('sha256')
    .update(`${secret}|${day}|${clientIp(req)}|${req.get('user-agent') || ''}`)
    .digest('hex').slice(0, 16);
}

/** "Where did they come from", from ?utm_source= or the referring site. null = from our own pages. */
export function sourceFrom(utm, referrer, ownHost) {
  const named = (s) => {
    s = s.toLowerCase();
    if (/(^|\.)google\./.test(s) || s === 'google') return 'Google';
    if (/(^|\.)bing\.com$/.test(s) || s === 'bing') return 'Bing';
    if (/instagram/.test(s) || s === 'ig') return 'Instagram';
    if (/facebook|(^|\.)fb\.|^fb$/.test(s)) return 'Facebook';
    if (/tiktok/.test(s)) return 'TikTok';
    if (/tripadvisor/.test(s)) return 'Tripadvisor';
    if (/yahoo|duckduckgo|ecosia/.test(s)) return 'Other search';
    return s.replace(/^www\./, '').slice(0, 40);
  };
  if (utm && String(utm).trim()) return named(String(utm).trim().slice(0, 40));
  if (!referrer) return 'Direct';
  let host;
  try { host = new URL(String(referrer)).hostname; } catch { return 'Direct'; }
  const bare = (x) => String(x || '').toLowerCase().replace(/^www\./, '');
  if (bare(host) === bare(ownHost)) return null;
  if (/onrender\.com$|localhost|127\.0\.0\.1/.test(host)) return null;
  return named(host);
}

/** Records one event. Never throws: stats must never break a page or a booking. */
export async function track(req, kind, extra = {}) {
  try {
    if (!KINDS.has(kind)) return false;
    if (isBot(req.get('user-agent'))) return false;
    if (isAdmin(req)) return false;
    const day = todayLocal();
    await query(
      `insert into site_events (day, visitor, kind, source, start_date, end_date, days, scooters, amount, booking_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [day, visitorId(req, day), kind, extra.source ?? null, extra.start ?? null, extra.end ?? null,
        extra.days ?? null, extra.scooters ?? null, extra.amount ?? null, extra.bookingId ?? null],
    );
    return true;
  } catch (err) {
    console.error('[visitors] track failed:', err.message);
    return false;
  }
}

// ── What one visitor did today ──
async function visitorDay(day, visitor) {
  const events = await query(
    `select e.kind, e.at, e.source, to_char(e.start_date, 'YYYY-MM-DD') as start, to_char(e.end_date, 'YYYY-MM-DD') as "end",
            e.days, e.scooters, e.amount, e.booking_id, b.status as booking_status
       from site_events e left join bookings b on b.id::text = e.booking_id
      where e.day = $1 and e.visitor = $2 order by e.at`, [day, visitor]);
  const source = events.find((e) => e.source)?.source || 'Direct';
  const seen = new Map();
  for (const e of events.filter((x) => x.kind === 'price_seen')) {
    seen.set(`${e.start}|${e.end}|${e.scooters}|${e.amount}`, e); // last view of each option wins
  }
  const options = [...seen.values()].slice(-5);
  const checkout = events.filter((e) => e.kind === 'checkout');
  const paid = checkout.some((e) => ['awaiting_bond', 'confirmed', 'active', 'returned', 'bond_released'].includes(e.booking_status));
  const outcome = paid ? 'booked' : checkout.length ? 'payment' : 'left';
  return { source, options, outcome, firstAt: events[0]?.at, lastAt: events.at(-1)?.at };
}

const OUTCOME = {
  booked: { label: 'Booked and paid', colour: '#2f7a4b', note: 'You\'ll also get the normal booking email.' },
  payment: { label: 'Went to the payment page but didn\'t pay', colour: '#b3701c', note: 'They saw the full price with the bond and stopped there.' },
  left: { label: 'Saw the price and left', colour: '#8b2a2a', note: 'They didn\'t go on to the payment page.' },
};

function optionLine(o) {
  return `${fmt(o.start)} → ${fmt(o.end)} · ${plural(o.days, 'day')} · ${plural(o.scooters, 'scooter')} · ${money(o.amount)}`;
}

/**
 * Sends "someone checked prices" emails for visitors who saw a price and then went quiet
 * for a few minutes. Returns how many were sent.
 */
export async function sendPriceAlerts(now = new Date()) {
  const to = process.env.OWNER_NOTIFY_EMAIL;
  if (!to && process.env.RESEND_API_KEY) return 0;
  const day = todayLocal(now);
  const quietSince = new Date(now.getTime() - cfg.alertAfterQuietMinutes * 60 * 1000);
  const ready = await query(
    `select e.visitor from site_events e
      where e.day = $1 and e.kind = 'price_seen'
        and not exists (select 1 from price_alerts a where a.day = e.day and a.visitor = e.visitor)
      group by e.visitor
     having max(e.at) <= $2
      order by min(e.at) limit 20`, [day, quietSince]);
  let sent = 0;
  for (const { visitor } of ready) {
    const [{ n }] = await query(`select count(*)::int as n from price_alerts where day = $1`, [day]);
    // Claim first (also when over the cap) so each visitor is only ever looked at once.
    const claim = await query(
      `insert into price_alerts (day, visitor) values ($1, $2) on conflict do nothing returning visitor`, [day, visitor]);
    if (!claim.length || n >= cfg.maxPriceAlertsPerDay) continue;
    const v = await visitorDay(day, visitor);
    if (!v.options.length) continue;
    const o = OUTCOME[v.outcome];
    const main = v.options.at(-1);
    const subject = v.outcome === 'booked'
      ? `Price check → booked: ${plural(main.days, 'day')}, ${money(main.amount)}`
      : `Someone checked prices: ${plural(main.days, 'day')}, ${plural(main.scooters, 'scooter')}, ${money(main.amount)}`;
    try {
      await sendEmail({
        to: to || '(OWNER_NOTIFY_EMAIL not set)',
        subject,
        html: `<p style="font-size:16px;margin:0 0 10px">A visitor checked prices at ${h(timeIn(v.firstAt))}.</p>
<p style="margin:0 0 6px"><b>What they looked at</b> (price = rent + delivery, without bond):</p>
<ul style="margin:0 0 12px;padding-left:18px">${v.options.map((x) => `<li>${h(optionLine(x))}</li>`).join('')}</ul>
<p style="margin:0 0 6px"><b>Came from:</b> ${h(v.source)}</p>
<p style="margin:0 0 6px;color:${o.colour}"><b>${h(o.label)}</b></p>
<p style="margin:0 0 12px;color:#6b4e42">${h(o.note)}</p>
<p style="margin:0;font-size:13px;color:#8f7566">See every visitor in the <a href="${baseUrl()}/admin">admin page</a> → Visitors. No names or contact details are recorded.</p>`,
        text: `A visitor checked prices at ${timeIn(v.firstAt)}.\n${v.options.map(optionLine).join('\n')}\nCame from: ${v.source}\n${o.label}`,
        idempotencyKey: `price-alert-${day}-${visitor}`,
      });
      await query(`update price_alerts set sent_at = now() where day = $1 and visitor = $2`, [day, visitor]);
      sent++;
    } catch (err) {
      console.error('[visitors] price alert failed:', err.message);
    }
  }
  return sent;
}

// ── Stats for the admin page and the evening summary ──
export async function stats(fromDay, toDay) {
  const [f] = await query(
    `select count(distinct visitor) filter (where kind = 'visit')      as visit,
            count(distinct visitor) filter (where kind = 'book_open')  as book_open,
            count(distinct visitor) filter (where kind = 'price_seen') as price_seen,
            count(distinct visitor) filter (where kind = 'checkout')   as checkout,
            count(distinct visitor)                                     as anyone
       from site_events where day between $1 and $2`, [fromDay, toDay]);
  const [p] = await query(
    `select count(*)::int as paid from bookings
      where status in ${PAID}
        and (created_at at time zone '${site.timezone}')::date between $1 and $2`, [fromDay, toDay]);
  const sources = await query(
    `select coalesce(src, 'Direct') as source, count(*)::int as visitors from (
       select (array_agg(source order by at) filter (where source is not null))[1] as src
         from site_events where day between $1 and $2 group by day, visitor) t
      group by 1 order by 2 desc, 1 limit 8`, [fromDay, toDay]);
  // Did people looking at short hires book less often than longer ones?
  const lengths = await query(
    `with v as (
       select day, visitor, max(days) filter (where kind = 'price_seen') as days,
              bool_or(kind = 'checkout') as went_to_payment
         from site_events where day between $1 and $2 group by day, visitor)
     select case when days = 1 then '1 day' when days <= 3 then '2–3 days' when days <= 6 then '4–6 days' else '7+ days' end as length,
            min(days) as sort, count(*)::int as saw_price, count(*) filter (where went_to_payment)::int as went_to_payment
       from v where days is not null group by 1 order by 2`, [fromDay, toDay]);
  return {
    from: fromDay, to: toDay,
    funnel: { visit: f.visit, bookOpen: f.book_open, priceSeen: f.price_seen, checkout: f.checkout, paid: p.paid, anyone: f.anyone },
    sources, lengths: lengths.map(({ sort, ...x }) => x),
  };
}

/** The latest visitors who saw a price, newest first. */
export async function recentPriceChecks(fromDay, toDay, limit = 25) {
  const rows = await query(
    `select to_char(day, 'YYYY-MM-DD') as day, visitor, max(at) as last_at from site_events
      where day between $1 and $2 and kind = 'price_seen'
      group by day, visitor order by max(at) desc limit $3`, [fromDay, toDay, limit]);
  const out = [];
  for (const r of rows) {
    const v = await visitorDay(r.day, r.visitor);
    out.push({ at: v.firstAt, source: v.source, outcome: v.outcome, options: v.options.map(({ start, end, days, scooters, amount }) => ({ start, end, days, scooters, amount })) });
  }
  return out;
}

/** Once a day after cfg.summaryHour, emails today's numbers. */
export async function sendDailySummary(now = new Date()) {
  const to = process.env.OWNER_NOTIFY_EMAIL;
  if (!to && process.env.RESEND_API_KEY) return false;
  if (hourIn(now) < cfg.summaryHour) return false;
  const day = todayLocal(now);
  const claim = await query(`insert into daily_reports (day) values ($1) on conflict do nothing returning day`, [day]);
  if (!claim.length) return false;
  const s = await stats(day, day);
  const f = s.funnel;
  const rows = [
    ['Visited the website', f.visit],
    ['Opened the booking page', f.bookOpen],
    ['Saw a price', f.priceSeen],
    ['Went to payment', f.checkout],
    ['Booked and paid', f.paid],
  ];
  const lostAtPrice = Math.max(0, f.priceSeen - f.checkout);
  try {
    await sendEmail({
      to: to || '(OWNER_NOTIFY_EMAIL not set)',
      subject: `Today on the website: ${plural(f.visit, 'visitor')}, ${plural(f.priceSeen, 'price check')}, ${plural(f.paid, 'booking')}`,
      html: `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:15px">
${rows.map(([k, v]) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${k}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right"><b>${v}</b></td></tr>`).join('')}
</table>
${f.priceSeen ? `<p style="margin:14px 0 0">${lostAtPrice ? `<b>${plural(lostAtPrice, 'person')}</b> saw a price and didn't go on to payment.` : 'Everyone who saw a price went on to payment.'}</p>` : ''}
${s.sources.length ? `<p style="margin:10px 0 0"><b>Came from:</b> ${s.sources.map((x) => `${h(x.source)} ${x.visitors}`).join(' · ')}</p>` : ''}
<p style="margin:14px 0 0;font-size:13px;color:#8f7566">Bots and your own visits while logged into admin aren't counted. More detail in the <a href="${baseUrl()}/admin">admin page</a> → Visitors.</p>`,
      text: rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
      idempotencyKey: `daily-summary-${day}`,
    });
    return true;
  } catch (err) {
    console.error('[visitors] daily summary failed:', err.message);
    await query(`delete from daily_reports where day = $1`, [day]).catch(() => {});
    return false;
  }
}

/** Every minute: price alerts + evening summary. Old stats are cleared after a year or so. */
export function startVisitorSweeps(everyMs = 60 * 1000) {
  let pruned = '';
  const run = async () => {
    try {
      await sendPriceAlerts();
      await sendDailySummary();
      const day = todayLocal();
      if (pruned !== day) {
        pruned = day;
        await query(`delete from site_events where day < current_date - 400`);
        await query(`delete from price_alerts where day < current_date - 30`);
      }
    } catch (err) {
      console.error('[visitors] sweep:', err.message);
    }
  };
  const t = setInterval(run, everyMs);
  t.unref();
  return t;
}
