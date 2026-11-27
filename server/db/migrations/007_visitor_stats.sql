-- Visitor stats: counts only. No IP addresses, names or cookies are stored —
-- "visitor" is a one-way hash that changes every day, so a person can't be
-- followed from one day to the next.
create table site_events (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  day         date not null,                -- Airlie Beach date
  visitor     text not null,
  kind        text not null check (kind in ('visit', 'book_open', 'price_seen', 'checkout')),
  source      text,                         -- google / instagram / direct / …
  start_date  date,
  end_date    date,
  days        int,
  scooters    int,
  amount      int,                          -- rent + delivery shown, in cents
  booking_id  text
);
create index site_events_day_kind on site_events (day, kind);
create index site_events_visitor on site_events (day, visitor);

-- One "someone checked prices" email per visitor per day.
create table price_alerts (
  day      date not null,
  visitor  text not null,
  sent_at  timestamptz,
  primary key (day, visitor)
);

-- One evening summary per day.
create table daily_reports (
  day      date primary key,
  sent_at  timestamptz not null default now()
);
