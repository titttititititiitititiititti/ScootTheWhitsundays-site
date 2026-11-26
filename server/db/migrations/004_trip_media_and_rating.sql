-- Pickup/return videos are stored per scooter.
alter table booking_media add column if not exists bike_number int;

-- End-of-trip rating (1–5 stars) and optional private feedback.
alter table bookings add column if not exists rating smallint check (rating between 1 and 5);
alter table bookings add column if not exists rating_feedback text;
alter table bookings add column if not exists rated_at timestamptz;
