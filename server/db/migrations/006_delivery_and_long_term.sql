-- Optional delivery at the start / collection at the end ($ per trip per scooter).
-- The address goes in bookings.customer_address.
alter table bookings add column if not exists delivery boolean not null default false;
alter table bookings add column if not exists collection boolean not null default false;
alter table bookings add column if not exists delivery_amount int not null default 0;

-- Long-term rentals you arrange yourself (weekly rent, paid to you directly).
create table if not exists long_term_rentals (
  id           serial primary key,
  bike_id      int not null references bikes(id) on delete cascade,
  renter_name  text not null,
  renter_phone text,
  weekly_rate  int not null check (weekly_rate >= 0),
  start_date   date not null,          -- rent is due on this day and every 7 days after
  end_date     date,                   -- null = still renting
  created_at   timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
create index if not exists long_term_rentals_bike on long_term_rentals (bike_id);

-- One row per week's rent once it's paid (or once a reminder was sent).
create table if not exists long_term_payments (
  id               serial primary key,
  rental_id        int not null references long_term_rentals(id) on delete cascade,
  due_date         date not null,
  amount           int not null,
  paid_at          timestamptz,
  reminder_sent_at timestamptz,
  unique (rental_id, due_date)
);
