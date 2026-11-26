-- Prices you edit in the admin page.
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Times a scooter can't be booked online (long-term rental, repair, ...).
-- end_date null = "until I change it".
create table if not exists bike_blocks (
  id         serial primary key,
  bike_id    int not null references bikes(id) on delete cascade,
  start_date date not null,
  end_date   date,
  reason     text not null default 'Unavailable',
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
create index if not exists bike_blocks_bike on bike_blocks (bike_id);

-- Scooters over 50cc need a motorcycle licence.
alter table bikes add column if not exists needs_motorcycle_licence boolean not null default false;
