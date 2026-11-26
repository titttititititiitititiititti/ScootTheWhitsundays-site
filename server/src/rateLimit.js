// Tiny in-memory rate limiter (one server instance, so this is enough).
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: 'Too many attempts — please wait a while or call us.' });
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    next();
  };
}
