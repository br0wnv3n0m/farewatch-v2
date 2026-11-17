// Sending email through Resend (free plan) and keeping a short log of every attempt.
// Secret: RESEND_API_KEY. Sender: EMAIL_FROM (a verified Resend domain).
import type { Env } from './http.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type EmailKind = 'fares' | 'stopped' | 'resumed' | 'repo' | 'test';

export interface SendResult {
  ok: boolean;
  message: string;
}

const DEFAULT_FROM = 'Farewatch <onboarding@resend.dev>';

/** Why email cannot be sent right now, or null when it can. */
export function emailBlocker(env: Env, to: string | null): string | null {
  if (!env.RESEND_API_KEY) return 'Email is off: the RESEND_API_KEY secret is not set on the server.';
  if (!to) return 'Email is off: add an alert email in Settings.';
  return null;
}

/**
 * Send one email. `key` is the Resend idempotency key: the same key within 24 hours
 * never sends a second copy, so a retry after a timeout is safe.
 */
export async function sendEmail(env: Env, msg: EmailMessage, key: string): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ from: env.EMAIL_FROM || DEFAULT_FROM, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, message: 'Email service could not be reached. It will be tried again.' };
  }
  if (res.ok) return { ok: true, message: 'Email accepted by Resend.' };
  // Resend's error text says what is wrong (bad key, unverified domain); keep it short.
  const detail = await res.json().then((b) => (b as { message?: string }).message ?? '', () => '');
  return { ok: false, message: `Email service returned HTTP ${res.status}${detail ? ': ' + String(detail).slice(0, 200) : ''}.` };
}

export async function logEmail(db: D1Database, now: number, kind: EmailKind, watchId: number | null, r: SendResult): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO email_log (at, kind, watch_id, ok, message) VALUES (?, ?, ?, ?, ?)').bind(now, kind, watchId, r.ok ? 1 : 0, r.message),
    db.prepare('DELETE FROM email_log WHERE id NOT IN (SELECT id FROM email_log ORDER BY id DESC LIMIT 200)'),
  ]);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Escape text for HTML (emails and the fare page). */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Simple email layout: white card, green accent (the app's light mode). */
export function emailLayout(title: string, bodyHtml: string, footerHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f1f5f2;font-family:Arial,Helvetica,sans-serif;color:#17301f">
<table role="presentation" width="100%" style="border-collapse:collapse"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:600px;border-collapse:collapse;background:#ffffff;border-radius:12px">
<tr><td style="padding:22px 24px 6px;font-size:20px;font-weight:700">Farewatch <span style="color:#16a34a">&#9679;</span></td></tr>
<tr><td style="padding:6px 24px 18px">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px 22px;border-top:1px solid #e3e9e5;font-size:12px;line-height:1.5;color:#5d6f65">${footerHtml}</td></tr>
</table></td></tr></table></body></html>`;
}
