// Sends email through Resend (https://resend.com) using its HTTP API — no SDK needed.
// Without RESEND_API_KEY (e.g. local testing) emails are written to
// DATA_DIR/outbox as .html files instead, so you can open and check them.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './db.js';

let testSink = null;
/** Tests can capture emails instead of sending them. */
export function setEmailSinkForTests(fn) { testSink = fn; }

export function outboxDir() { return path.join(dataDir(), 'outbox'); }

/**
 * @param {{to: string|string[], subject: string, html: string, text: string, replyTo?: string, idempotencyKey?: string}} msg
 */
export async function sendEmail(msg) {
  if (testSink) return testSink(msg);
  const from = process.env.EMAIL_FROM || 'Airlie Scooter Hire <onboarding@resend.dev>';
  const key = process.env.RESEND_API_KEY;

  if (!key) {
    await mkdir(outboxDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = msg.subject.replace(/[^\w]+/g, '-').slice(0, 60);
    const file = path.join(outboxDir(), `${stamp}-${slug}.html`);
    const header = `<pre style="background:#eee;padding:8px;font:12px monospace">To: ${escapeHtml([].concat(msg.to).join(', '))}\nSubject: ${escapeHtml(msg.subject)}${msg.replyTo ? `\nReply-To: ${escapeHtml(msg.replyTo)}` : ''}</pre>`;
    await writeFile(file, header + msg.html);
    console.log(`[email] (no RESEND_API_KEY) saved "${msg.subject}" → ${file}`);
    return { id: 'outbox', file };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(msg.idempotencyKey ? { 'Idempotency-Key': msg.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from,
      to: [].concat(msg.to),
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
