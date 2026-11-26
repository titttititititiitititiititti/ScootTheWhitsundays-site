import express, { Router } from 'express';
import { stripe, handleStripeEvent } from '../payments.js';

const r = Router();

// POST /api/stripe/webhook — Stripe tells us a payment succeeded / a checkout expired.
// The signature check proves the request really came from Stripe.
r.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe() || !secret) return res.status(503).send('Stripe not configured');
  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, req.get('stripe-signature'), secret);
  } catch (err) {
    console.warn('[stripe] webhook signature check failed:', err.message);
    return res.status(400).send('Bad signature');
  }
  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error(`[stripe] failed to handle ${event.type}:`, err);
    res.status(500).send('Error'); // Stripe retries automatically
  }
});

export default r;
