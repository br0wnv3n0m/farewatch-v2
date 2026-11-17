// Small HTTP helpers: JSON responses, typed errors, size-limited body reading.
import { InputError } from './rules.ts';

export interface Env {
  DB: D1Database;
  /** Secret. App login password, 12+ characters. */
  ADMIN_PASSWORD?: string;
  /** Secret. GitHub Actions runner token, 32+ characters. Only reaches /api/runner/*. */
  RUNNER_TOKEN?: string;
  /** Comma list of app origins allowed to call the API from a browser/webview. */
  ALLOWED_ORIGINS?: string;
  /** Secret. Resend API key (sending access) for alert emails. */
  RESEND_API_KEY?: string;
  /** Sender, e.g. "Farewatch <farewatch@example.com>"; its domain must be verified in Resend. */
  EMAIL_FROM?: string;
  /** This Worker's public address, used in fare links (the cron has no request URL). */
  PUBLIC_URL?: string;
  /** Secret. Fine-grained GitHub token (farewatch-v2 only, Actions: read and write). Lets the cron start the workflow. */
  GITHUB_TOKEN?: string;
}

/** Everything a route needs. `now` is passed in so tests can fix the clock. */
export interface Ctx {
  env: Env;
  request: Request;
  url: URL;
  now: number;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: BASE_HEADERS });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  if (err instanceof InputError) return json({ error: err.message }, 400);
  console.error('unhandled error', err);
  return json({ error: 'Server error. Nothing was changed.' }, 500);
}

/** Read a JSON body with a size limit (bytes). */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > maxBytes) throw new HttpError(413, 'Request too large.');
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError(413, 'Request too large.');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

/** Positive integer id from a URL part. */
export function idParam(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'Not found.');
  return n;
}
