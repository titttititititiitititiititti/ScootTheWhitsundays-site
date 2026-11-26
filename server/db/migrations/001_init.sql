-- Bikes in the fleet
create table bikes (
  id              serial primary key,
  number          integer not null unique,          -- "Bike 1", "Bike 2" …
  name            text not null,                    -- model, e.g. Kymco Like 50cc
  photo           text,                             -- image path/URL
  status          text not null default 'available'
                  check (status in ('available', 'in_repair', 'retired')),
  owner           text not null default 'me',       -- partner name (splits come later)
  lockbox_number  text,
  lockbox_code    text,
  daily_rate      integer,                          -- cents; null = use config.js pricing
  notes           text,
  -- later phase: Igloohome smart lockbox
  igloo_device_id text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table bookings (
  id                  uuid primary key default gen_random_uuid(),
  access_token        text not null unique,         -- secret for the customer's trip page link
  scooter_count       integer not null check (scooter_count >= 1),  -- bikes are in booking_bikes

  customer_name       text not null,
  customer_email      text not null,
  customer_phone      text not null,
  customer_dob        date,
  customer_address    text,
  riders              text,

  licence_country     text,
  licence_number      text not null,
  licence_type        text not null,
  licence_expiry      date,
  licence_12_months   boolean,
  at_fault_accidents  boolean,
  accident_details    text,
  driving_restrictions boolean,
  restriction_details text,

  start_date          date not null,
  end_date            date not null,
  days                integer not null,
  rent_amount         integer not null,             -- cents, all scooters
  bond_amount         integer not null,             -- cents, all scooters
  bond_method         text not null check (bond_method in ('hold', 'charge')),
  bond_status         text not null default 'none'
                      check (bond_status in ('none', 'held', 'charged', 'released', 'partially_kept', 'kept')),
  bond_kept_amount    integer not null default 0,   -- cents
  bond_kept_reason    text,

  stripe_checkout_session_id     text unique,
  stripe_customer_id             text,
  stripe_payment_intent_id       text,              -- rent
  stripe_bond_payment_intent_id  text,              -- bond hold or charge

  status              text not null default 'pending_payment'
                      check (status in ('pending_payment', 'confirmed', 'active', 'returned',
                                        'bond_released', 'cancelled')),
  pending_expires_at  timestamptz,                  -- unpaid bookings stop blocking the bike after this

  -- signed rental agreement
  agreement           jsonb not null,               -- exact text + every box ticked
  signature_name      text not null,
  signature_date      date not null,
  agreement_signed_at timestamptz not null,
  signer_ip           text,

  -- later phases
  igloo_pin_id                 text,
  identity_verification_status text,
  return_reminder_sent_at      timestamptz,

  confirmation_sent_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  check (end_date >= start_date)
);

create index bookings_dates on bookings (start_date, end_date);
create index bookings_status on bookings (status);

-- Which bikes are in each booking (a booking can have several)
create table booking_bikes (
  booking_id  uuid not null references bookings(id) on delete cascade,
  bike_id     integer not null references bikes(id),
  primary key (booking_id, bike_id)
);

create index booking_bikes_bike on booking_bikes (bike_id);

-- Pickup / return videos and photos
create table booking_media (
  id          serial primary key,
  booking_id  uuid not null references bookings(id) on delete cascade,
  phase       text not null check (phase in ('pickup', 'return')),
  file_path   text not null,
  mime_type   text not null,
  size_bytes  bigint not null,
  created_at  timestamptz not null default now()
);

create index booking_media_booking on booking_media (booking_id);
