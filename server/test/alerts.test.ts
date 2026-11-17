// Step 4: fare alert emails, fare pages, price history, "checks have stopped" monitor.
// Resend is replaced by a fake fetch that records every email.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { shouldAlert } from '../src/alerts.ts';
import { handle } from '../src/app.ts';
import { runMonitor, scheduled } from '../src/monitor.ts';
import type { Leg } from '../src/rules.ts';
import { createD1 } from './d1shim.ts';

const NOW = Date.UTC(2026, 10, 17, 12, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PASSWORD = 'correct horse battery';
const RUNNER = 'r'.repeat(40);

type TestEnv = { DB: D1Database; ADMIN_PASSWORD: string; RUNNER_TOKEN: string; RESEND_API_KEY?: string; PUBLIC_URL: string };
let env: TestEnv;
let sent: { key: string; body: { to: string[]; subject: string; html: string; text: string } }[];
let resendStatus: number;
const realFetch = globalThis.fetch;

async function call(method: string, path: string, body?: unknown, o: { token?: string; runner?: boolean; now?: number } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' };
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  if (o.runner) headers.Authorization = 'Bearer ' + RUNNER;
  const res = await handle(new Request('https://fw.example' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env as never, o.now ?? NOW);
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* HTML page */ }
  return { status: res.status, body: parsed as any };
}

function flight(a: string, b: string, day: string) {
  return { departure_airport: { id: a, time: `${day} 08:00` }, arrival_airport: { id: b, time: `${day} 12:00` }, flight_number: 'AC1', airline: 'Air Canada' };
}
function leg(day: string, ...airports: string[]): Leg {
  return { price: 0, flights: airports.slice(0, -1).map((a, i) => flight(a, airports[i + 1], day)), layovers: airports.slice(1, -1).map((id) => ({ id, duration: 120 })) };
}
const option = (price: number, out: string, back: string) => ({ price, out: leg(out, 'YVR', 'HKG', 'DEL'), back: leg(back, 'DEL', 'HKG', 'YVR'), airlines: ['AC'] });

const WATCH = {
  name: 'India trip', origin: 'YVR', destination: 'DEL', currency: 'CAD', adults: 1, children: 0, cabin: 1, maxStops: 1, maxLayover: 360,
  outDates: { from: '2026-12-20', to: '2026-12-20' }, backDates: { from: '2027-01-05', to: '2027-01-05' },
  blockedCountries: ['US'], airlines: [], budget: 2500, reserve: 100, bags: 0, allowUnverifiedBags: false, pairsPerRun: 1, enabled: true,
};

/** Lease the one combo and report one price for it. */
async function check(price: number | null, now: number) {
  const job = (await call('POST', '/api/runner/job', {}, { runner: true, now })).body;
  assert.ok(job.runId, JSON.stringify(job));
  const cells = [{ out: '2026-12-20', back: '2027-01-05', status: price === null ? 'none' : 'ok', options: price === null ? [] : [option(price, '2026-12-20', '2027-01-05')] }];
  const r = await call('POST', '/api/runner/report', { runId: job.runId, cells }, { runner: true, now });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.message as string;
}

async function setup(watch = WATCH) {
  const token = (await call('POST', '/api/login', { password: PASSWORD })).body.token as string;
  await call('PUT', '/api/settings', { blockedCountries: ['US'], currency: 'CAD', alertEmail: 'me@example.com' }, { token });
  const id = (await call('POST', '/api/watches', watch, { token })).body.id as number;
  return { token, id };
}

beforeEach(() => {
  env = { DB: createD1(), ADMIN_PASSWORD: PASSWORD, RUNNER_TOKEN: RUNNER, RESEND_API_KEY: 're_test', PUBLIC_URL: 'https://fw.example' };
  sent = [];
  resendStatus = 200;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails');
    const headers = init.headers as Record<string, string>;
    sent.push({ key: headers['Idempotency-Key'], body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(resendStatus === 200 ? { id: 'e1' } : { message: 'API key is invalid' }), { status: resendStatus });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('alert rule', () => {
  test('new fare, 2% drop after 24 h', () => {
    assert.equal(shouldAlert(2000, null, NOW), true);
    assert.equal(shouldAlert(1960, { price: 2000, at: NOW - 25 * HOUR }, NOW), true); // exactly 2%
    assert.equal(shouldAlert(1970, { price: 2000, at: NOW - 25 * HOUR }, NOW), false); // 1.5%
    assert.equal(shouldAlert(1500, { price: 2000, at: NOW - 23 * HOUR }, NOW), false); // too soon
  });
});

describe('fare alert emails', () => {
  test('under budget sends once; same price again does not; 2% drop a day later does', async () => {
    await setup();
    const msg = await check(2300, NOW); // 2300 + 100 reserve <= 2500
    assert.match(msg, /Alert email sent/);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body.to, ['me@example.com']);
    assert.match(sent[0].body.subject, /YVR–DEL from .*2,300/);
    assert.match(sent[0].body.text, /https:\/\/fw\.example\/fare\/[0-9a-f]{32}/);

    await check(2300, NOW + 51 * MIN);
    await check(2290, NOW + 2 * 51 * MIN); // small drop
    assert.equal(sent.length, 1);
    await check(2200, NOW + 25 * HOUR);
    assert.equal(sent.length, 2);
  });

  test('over budget (with reserve) sends nothing', async () => {
    await setup();
    await check(2450, NOW); // 2450 + 100 > 2500
    assert.equal(sent.length, 0);
  });

  test('bags without consent send nothing; with consent they do', async () => {
    const { token, id } = await setup({ ...WATCH, bags: 1, allowUnverifiedBags: false });
    await check(2000, NOW);
    assert.equal(sent.length, 0);
    await call('PUT', `/api/watches/${id}`, { ...WATCH, bags: 1, allowUnverifiedBags: true }, { token });
    await scheduled(env as never, NOW + 5 * MIN); // the cron picks it up without a new check
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.text, /1 checked bag/);
  });

  test('failed send is retried by the cron with the same key and the same links', async () => {
    await setup();
    resendStatus = 401;
    assert.match(await check(2000, NOW), /failed/);
    resendStatus = 200;
    await scheduled(env as never, NOW + 30 * MIN);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].key, sent[1].key);
    assert.equal(sent[0].body.html, sent[1].body.html); // same payload: Resend idempotency works
    await scheduled(env as never, NOW + 60 * MIN);
    assert.equal(sent.length, 2); // marked as alerted after success
  });

  test('no RESEND_API_KEY: nothing sent, status explains it', async () => {
    const { token } = await setup();
    delete env.RESEND_API_KEY;
    await check(2000, NOW);
    assert.equal(sent.length, 0);
    const status = (await call('GET', '/api/status', undefined, { token })).body.alerts;
    assert.match(status.emailBlocker, /RESEND_API_KEY/);
  });

  test('fare link page works, has no private data, and expires after 30 days', async () => {
    await setup();
    await check(2000, NOW);
    const path = sent[0].body.text.match(/\/fare\/[0-9a-f]{32}/)![0];
    const page = await call('GET', path);
    assert.equal(page.status, 200);
    assert.match(page.body, /YVR → DEL/);
    assert.doesNotMatch(page.body, /me@example\.com|India trip|2,500/); // no email, watch name or budget
    assert.equal((await call('GET', path, undefined, { now: NOW + 31 * DAY })).status, 410);
    assert.equal((await call('GET', '/fare/' + '0'.repeat(32))).status, 404);
  });

  test('test email route', async () => {
    const { token } = await setup();
    const r = await call('POST', '/api/alerts/test', {}, { token });
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
    resendStatus = 403;
    assert.equal((await call('POST', '/api/alerts/test', {}, { token })).status, 502);
    const log = (await call('GET', '/api/status', undefined, { token })).body.alerts.recentEmails;
    assert.equal(log[0].ok, false);
  });
});

describe('price history', () => {
  test('daily lows, per-combo stats and points', async () => {
    const { token, id } = await setup();
    await check(2300, NOW);
    await check(2100, NOW + 51 * MIN);
    await check(2400, NOW + DAY);
    const h = (await call('GET', `/api/watches/${id}/history`, undefined, { token })).body;
    assert.deepEqual(h.days, [{ day: '2026-11-17', low: 2100 }, { day: '2026-11-18', low: 2400 }]);
    assert.deepEqual(h.combos, [{ out: '2026-12-20', back: '2027-01-05', low: 2100, high: 2400, checks: 3, lastAt: NOW + DAY, latest: 2400 }]);
    assert.equal(h.points, null);
    const one = (await call('GET', `/api/watches/${id}/history?out=2026-12-20&back=2027-01-05`, undefined, { token })).body;
    assert.deepEqual(one.points.map((p: { price: number }) => p.price), [2300, 2100, 2400]);
    assert.equal((await call('GET', `/api/watches/${id}/history?out=bad`, undefined, { token })).status, 400);
  });
});

describe('checks-stopped monitor', () => {
  const status = async (token: string) => (await call('GET', '/api/status', undefined, { token })).body.alerts;

  test('no polls for 3 h: one email, reminder after 3 days, recovery email', async () => {
    const { token } = await setup();
    await call('POST', '/api/runner/due', {}, { runner: true });
    await check(null, NOW); // successful search, nothing found
    await runMonitor(env as never, NOW + 2 * HOUR);
    assert.equal(sent.length, 0);
    await runMonitor(env as never, NOW + 4 * HOUR);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.subject, /checks have stopped/);
    assert.ok((await status(token)).outageSince);
    await runMonitor(env as never, NOW + 5 * HOUR);
    assert.equal(sent.length, 1); // no repeat
    await runMonitor(env as never, NOW + 4 * HOUR + 3 * DAY + MIN);
    assert.equal(sent.length, 2); // reminder
    const later = NOW + 4 * DAY;
    await call('POST', '/api/runner/due', {}, { runner: true, now: later });
    await check(null, later);
    await runMonitor(env as never, later + MIN);
    assert.match(sent[2].body.subject, /working again/);
    assert.equal((await status(token)).outageSince, null);
  });

  test('polling but no successful search for 6 h', async () => {
    await setup();
    for (let t = NOW; t <= NOW + 7 * HOUR; t += HOUR) await call('POST', '/api/runner/due', {}, { runner: true, now: t });
    await runMonitor(env as never, NOW + 7 * HOUR);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.text, /No successful flight search/);
  });

  test('no active watch: no alert', async () => {
    const { token, id } = await setup();
    await call('PATCH', `/api/watches/${id}`, { enabled: false }, { token });
    await runMonitor(env as never, NOW + 10 * HOUR);
    assert.equal(sent.length, 0);
  });

  test('GitHub 60-day pause: warning at 50 days, named in the stopped email', async () => {
    await setup();
    const commitAt = Math.floor((NOW - 51 * DAY) / 1000);
    await call('POST', '/api/runner/due', { commitAt }, { runner: true });
    await check(null, NOW);
    await runMonitor(env as never, NOW + MIN);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.subject, /GitHub will pause/);
    await runMonitor(env as never, NOW + HOUR);
    assert.equal(sent.length, 1); // weekly at most
    // Day 61: GitHub paused the schedule, polls stopped.
    await runMonitor(env as never, NOW + 10 * DAY);
    const stopped = sent.find((s) => /checks have stopped/.test(s.body.subject))!;
    assert.match(stopped.body.text, /no commit for 61 days.*paused/);
  });
});
