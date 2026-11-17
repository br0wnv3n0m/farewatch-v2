// Login for the app (password -> session token) and the runner token check.
// Tokens travel as "Authorization: Bearer <token>". No cookies, so no CSRF.
import { type Ctx, HttpError, json, readJson } from './http.ts';
import { asObject } from './rules.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const SESSION_MS = 90 * 24 * HOUR;
const MIN_PASSWORD = 12;
const MIN_RUNNER_TOKEN = 32;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two secrets without leaking where they differ (compares their hashes). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function bearer(request: Request): string {
  const h = request.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function password(ctx: Ctx): string {
  const p = ctx.env.ADMIN_PASSWORD ?? '';
  if (p.length < MIN_PASSWORD) throw new HttpError(503, `Server password is not set. Run: npx wrangler secret put ADMIN_PASSWORD (${MIN_PASSWORD}+ characters).`);
  return p;
}

/** POST /api/login {password, label?} -> {token, expiresAt} */
export async function login(ctx: Ctx): Promise<Response> {
  const { env, request, now } = ctx;
  const secret = password(ctx);
  const ipHash = await sha256Hex(request.headers.get('CF-Connecting-IP') ?? 'unknown');

  // Slow down guessing: 5 wrong tries per IP per 15 min, 30 in total per hour.
  const perIp = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip_hash = ? AND at > ?').bind(ipHash, now - 15 * MINUTE).first<{ n: number }>();
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE at > ?').bind(now - HOUR).first<{ n: number }>();
  if ((perIp?.n ?? 0) >= 5 || (total?.n ?? 0) >= 30) throw new HttpError(429, 'Too many wrong passwords. Wait 15 minutes and try again.');

  const body = asObject(await readJson(request, 4096));
  const given = typeof body.password === 'string' ? body.password : '';
  if (!given || !(await sameSecret(given, secret))) {
    await env.DB.prepare('INSERT INTO login_failures (ip_hash, at) VALUES (?, ?)').bind(ipHash, now).run();
    throw new HttpError(401, 'Wrong password.');
  }

  const token = randomHex(32);
  const label = typeof body.label === 'string' ? body.label.slice(0, 60) : '';
  const expiresAt = now + SESSION_MS;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - 24 * HOUR),
    env.DB.prepare('INSERT INTO sessions (token_hash, binding, label, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      await sha256Hex(token), await sha256Hex(secret + ':' + token), label, now, expiresAt, now),
  ]);
  return json({ token, expiresAt });
}

/** Throws 401 unless the request carries a live session token. */
export async function requireSession(ctx: Ctx): Promise<void> {
  const { env, request, now } = ctx;
  const secret = password(ctx);
  const token = bearer(request);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Please sign in.');
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT binding, last_used_at FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(hash, now).first<{ binding: string; last_used_at: number }>();
  if (!row || row.binding !== (await sha256Hex(secret + ':' + token))) throw new HttpError(401, 'Session expired. Please sign in again.');
  if (now - row.last_used_at > HOUR) await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').bind(now, hash).run();
}

/** POST /api/logout: ends this session only. */
export async function logout(ctx: Ctx): Promise<Response> {
  const token = bearer(ctx.request);
  if (token) await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true });
}

/** Throws 401 unless the request carries the runner token. */
export async function requireRunner(ctx: Ctx): Promise<void> {
  const expected = ctx.env.RUNNER_TOKEN ?? '';
  if (expected.length < MIN_RUNNER_TOKEN) throw new HttpError(503, `Runner token is not set. Run: npx wrangler secret put RUNNER_TOKEN (${MIN_RUNNER_TOKEN}+ characters).`);
  const given = bearer(ctx.request);
  if (!given || !(await sameSecret(given, expected))) throw new HttpError(401, 'Invalid runner token.');
}
