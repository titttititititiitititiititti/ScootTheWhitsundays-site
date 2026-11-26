# Go-live checklist — Airlie Scooter Hire booking system

Your current site stays live and untouched until step 6. Do the steps in order.

## 1. Verify your email domain in Resend
- resend.com → Domains → airliescooterhire.com. It must say **Verified**, not Pending.
- If it's still pending, check that the DNS records Resend shows are added where your domain's DNS is managed (Cloudflare). Copy them exactly, and set them to **DNS only** (grey cloud).
- Without this step, customers won't get their confirmation emails.

## 2. Get your Stripe *live* keys
- dashboard.stripe.com → turn **Test mode** off. Finish account activation if Stripe asks (bank account, ID).
- Developers → API keys → copy the **Secret key** (starts with `sk_live_`).
- Leave the webhook for step 4, because it needs the new web address first.

## 3. Create the server on Render (Blueprint)
- dashboard.render.com → **New → Blueprint** → choose the `ScootTheWhitsundays-site` repo, then branch `self-service-booking`.
- Render reads `render.yaml` and asks for these values. Type them in:

  | Name | What to enter | Where it comes from |
  |---|---|---|
  | `STRIPE_SECRET_KEY` | `sk_live_…` | Stripe → Developers → API keys |
  | `STRIPE_WEBHOOK_SECRET` | type `pending` for now | You replace it in step 4 |
  | `RESEND_API_KEY` | `re_…` | resend.com → API Keys (you can reuse the one in `server/.env`) |
  | `OWNER_NOTIFY_EMAIL` | your email | Where booking and rent-due emails go |
  | `ADMIN_PIN` | your admin PIN | Your choice (same as in `server/.env`) |

- These are filled in automatically: `DATABASE_URL`, `DATA_DIR`, `PUBLIC_BASE_URL`, `EMAIL_FROM`, `NODE_VERSION`, and `SESSION_SECRET` (random).
- It creates two things:
  - the web service: Starter, about US$7/month, plus a 5 GB disk for videos and photos at about US$1.25/month;
  - a Postgres database: Basic 256 MB, about US$6/month, which holds bookings, prices and rentals and is backed up daily.
- Click **Apply**. Wait for the deploy to show **Live**. Note the address it gives you, like `https://airlie-scooter-hire.onrender.com`.

## 4. Point Stripe at the new server
- Stripe (live mode) → Developers → Webhooks → **Add endpoint**.
  - URL: `https://airliescooterhire.com/api/stripe/webhook`
  - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
- Copy the **Signing secret** (`whsec_…`).
- In Render → the service → **Environment** → set `STRIPE_WEBHOOK_SECRET` to it → **Save** (this redeploys).

## 5. Check it on the .onrender.com address
- Open `https://<your-service>.onrender.com`. The prices should say $60.
- Tap the big "Airlie Scooter Hire" title 5 times quickly, then enter your PIN.
- In Admin → Scooters, mark the long-term rentals: Bikes 1, 2, 3, 5, 6 and 7, each with renter, weekly price and start day. Only one Agility should be left free.
- Don't do a real paid booking yet, because the webhook URL from step 4 only works once the domain points here.

## 6. Move your domain to the new server
- Render → the **old static site** → Settings → Custom Domains → delete `airliescooterhire.com` (and `www`).
- Render → the **new web service** → Settings → Custom Domains → add `airliescooterhire.com` (and `www`).
- If Render shows different DNS records, update them in Cloudflare. Wait until Render shows **Verified** and the certificate is issued.
- Visit https://airliescooterhire.com and check it says $60/day.

## 7. Do one real booking
- Book 1 day on yourself and pay with a real card.
- You should get the customer email and the owner email, and the booking should show in admin.
- Then refund it in Stripe.

## 8. Tidy up (tell Claude when you get here)
- Claude merges the branch into `main` and switches `render.yaml` to `main`. Then in Render, change the service's branch to `main`.
- Once you're happy, suspend or delete the old static site in Render.

## Every environment variable

| Name | Needed | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes | Takes payments and bond holds |
| `STRIPE_WEBHOOK_SECRET` | yes | Confirms bookings after payment |
| `RESEND_API_KEY` | yes | Sends emails |
| `EMAIL_FROM` | yes | Sender, needs a verified domain |
| `OWNER_NOTIFY_EMAIL` | yes | Your inbox for bookings and rent-due emails |
| `ADMIN_PIN` | yes | Admin login |
| `SESSION_SECRET` | yes | Signs the admin login cookie (auto-generated) |
| `PUBLIC_BASE_URL` | yes | Links in emails and Stripe return pages |
| `DATA_DIR` | yes | `/var/data`, the disk |
| `NODE_VERSION` | yes | `24` |
| `DATABASE_URL` | yes | Filled in automatically from the Render database |

## If something goes wrong
- Booking site broken after step 6: put the domain back on the old static site (step 6 in reverse). The old site comes back as it was.
- Render → service → **Logs** shows errors. Paste them to Claude.
