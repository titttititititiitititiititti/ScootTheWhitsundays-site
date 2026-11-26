// ─────────────────────────────────────────────────────────────────────
//  Airlie Scooter Hire — business settings
//  Change prices, bond and pickup details here, then restart the server.
//  All money is in CENTS (6500 = $65.00). Secrets do NOT go here — they
//  live in environment variables (see .env.example).
// ─────────────────────────────────────────────────────────────────────

export const pricing = {
  currency: 'aud',
  // STARTING prices only — once you save prices in the admin page, those are used instead.
  dailyRate: 6000,        // per scooter per day
  oneDayExtra: 1000,      // added when the hire is a single day ($60 + $10 = $70)
  weeklyRate: 0,          // optional price per full 7 days (0 = off, every day costs the daily rate)
  deliveryFee: 1000,      // per scooter per trip: delivery at the start and/or collection at the end

  // true:  Mon → Wed = 3 days (pickup day and return day both count; same as the old form)
  // false: Mon → Wed = 2 days (count nights); a same-day hire is still 1 day
  countBothEnds: true,

  maxHireDays: 60,
};

export const bond = {
  amount: 25000,          // $250 PER SCOOTER (2 scooters = $500 bond)
  // Stripe card holds only last ~7 days from when they are placed (at booking).
  // If the return date is at most this many days after today → card HOLD (released, never charged).
  // Otherwise → bond is CHARGED and refunded after return (Stripe keeps its fee).
  holdIfReturnWithinDays: 6,
};

export const booking = {
  timezone: 'Australia/Brisbane',
  // An unpaid checkout reserves the bikes for this long, then frees them up.
  // Must be longer than the Stripe payment window below, so a payment can
  // never complete after the bikes have been released to someone else.
  pendingHoldMinutes: 40,
  checkoutWindowMinutes: 30,   // Stripe's minimum is 30
  // TODO: fill in real details (shown in confirmation email + trip page)
  pickupAddress: 'TBC — carport address',
  pickupFromTime: '9:00 am',
  returnByTime: '5:00 pm',
  // Where customers may ride. Shown in the agreement they sign, the confirmation email and the trip page.
  ridingArea: {
    summary: 'You can ride anywhere around Airlie Beach, except these two roads:',
    noGo: [
      'Do not ride up the hill past Club Wyndham. It is extremely steep and destroys the scooters.',
      'Do not ride past the golf course. That road leads onto the highway.',
    ],
  },
  pickupInstructions: [
    'Bikes are parked in the carport at the address above.',
    "Find the lockbox with your bike's lockbox number and open it with your code to get the key.",
    'Helmets are on the hooks — please hang them back up when you return.',
    'On return, park the bike in the same spot and put the key back in the same lockbox.',
  ],
};

export const longTerm = {
  // On the day weekly rent is due, if you haven't marked it paid in the admin
  // page by this hour (Brisbane time), you get a "rent due today" email.
  reminderHour: 9,
};

export const business = {
  name: 'Airlie Scooter Hire',
  phone: '+61 478 393 479',
};
