// Admin login: a PIN (ADMIN_PIN env var) gives a signed, HTTP-only cookie that
// lasts 30 days, so your phone stays logged in. Changing ADMIN_PIN logs every
// device out. Guessing is limited (see routes/admin.js) because a 4-digit PIN
// alone would otherwise be quick to brute-force.
import crypto from 'node:crypto';

const COOKIE = 'ash_admin';
const MAX_AGE_S = 30 * 24 * 60 * 60;
let fallbackSecret = null;

export const adminEnabled = () => Boolean(process.env.ADMIN_PIN);

function secret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (!fallbackSecret) {
    fallbackSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[admin] SESSION_SECRET not set: admin logins will end whenever the server restarts');
  }
  return fallbackSecret;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
// Part of every session, so a new PIN invalidates old sessions.
const pinStamp = () => sha('pin:' + process.env.ADMIN_PIN).toString('base64url').slice(0, 12);
const mac = (body) => crypto.createHmac('sha256', secret()).update(body).digest();

/** Constant-time PIN check. */
export function checkPin(pin) {
  if (!adminEnabled() || typeof pin !== 'string' || pin.length > 32) return false;
  return crypto.timingSafeEqual(sha(pin), sha(process.env.ADMIN_PIN));
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function isAdmin(req) {
  if (!adminEnabled()) return false;
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const got = Buffer.from(sig, 'base64url');
  const want = mac(body);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() && p.v === pinStamp();
  } catch { return false; }
}

const flags = (req) => `Path=/; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`;

export function startSession(req, res) {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + MAX_AGE_S * 1000, v: pinStamp() })).toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${body}.${mac(body).toString('base64url')}; Max-Age=${MAX_AGE_S}; ${flags(req)}`);
}

export function endSession(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${flags(req)}`);
}

export function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Please log in again.' });
}
