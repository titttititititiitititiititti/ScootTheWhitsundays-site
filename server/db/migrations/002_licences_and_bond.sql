-- Licence photos are stored as booking media with phase 'licence'.
alter table booking_media drop constraint booking_media_phase_check;
alter table booking_media add constraint booking_media_phase_check
  check (phase in ('pickup', 'return', 'licence'));

-- 'awaiting_bond': rent is paid but the card hold for the bond didn't go
-- through, so the customer must secure the bond before getting the lockbox code.
alter table bookings drop constraint bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('pending_payment', 'awaiting_bond', 'confirmed', 'active', 'returned',
                    'bond_released', 'cancelled'));

alter table bookings add column bond_checkout_session_id text;
alter table bookings add column paid_at timestamptz;
