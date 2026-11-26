-- A retried "Continue to payment" (e.g. after a dropped connection) reuses the
-- same reservation instead of blocking the customer's own scooters.
alter table bookings add column if not exists request_key text;
create unique index if not exists bookings_request_key_live
  on bookings (request_key) where request_key is not null and status <> 'cancelled';

-- Customer confirmation (confirmation_sent_at) and owner notification are tracked separately,
-- so a failure on one never re-sends the other.
alter table bookings add column if not exists owner_notified_at timestamptz;
