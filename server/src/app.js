import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import publicApi from './routes/public.js';
import bookingsApi from './routes/bookings.js';
import stripeWebhook from './routes/stripeWebhook.js';
import tripApi from './routes/trip.js';
import adminApi from './routes/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.join(here, '..', '..');      // the existing static site
const newPages = path.join(here, '..', 'public');  // new booking / trip / admin pages

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Render's proxy

  // Webhook needs the raw body for Stripe's signature check, so it goes before the JSON parser.
  app.use('/api/stripe/webhook', stripeWebhook);
  // Booking requests carry licence photos (shrunk on the phone first).
  app.use('/api/bookings', express.json({ limit: '15mb' }));
  app.use('/api/admin', express.json({ limit: '20kb' }), adminApi);
  app.use('/api', express.json({ limit: '100kb' }), publicApi, bookingsApi, tripApi); // trip videos are raw bodies, not JSON

  // Existing site — only these files are served (never server/ source, .env or uploads)
  for (const f of ['index.html', 'privacy.html', 'robots.txt', 'sitemap.xml']) {
    app.get('/' + f, (_req, res) => res.sendFile(path.join(siteRoot, f)));
  }
  app.get('/', (_req, res) => res.sendFile(path.join(siteRoot, 'index.html')));
  app.use('/Static', express.static(path.join(siteRoot, 'Static'), { maxAge: '7d' }));
  app.use(express.static(newPages, { extensions: ['html'] }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Those photos are too large. Please try smaller ones.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again or call us.' });
  });
  return app;
}
