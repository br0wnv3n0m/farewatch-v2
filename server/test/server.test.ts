// End-to-end tests against the real routes and the real schema (in-memory SQLite).
// Run: npm test
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { handle } from '../src/app.ts';
import { acceptableLeg, combos, InputError, type Leg, validateWatch } from '../src/rules.ts';
import { createD1 } from './d1shim.ts';

const NOW = Date.UTC(2026, 10, 17, 12, 0); // 2026-11-17
const MIN = 60_000;
const PASSWORD = 'correct horse battery';
const RUNNER = 'r'.repeat(40);
const APP_ORIGIN = 'http://tauri.localhost';

let env: { DB: D1Database; ADMIN_PASSWORD: string; RUNNER_TOKEN: string };

interface Opts { token?: string; runner?: boolean; origin?: string; now?: number; ip?: string }

async function call(method: string, path: string, body?: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': o.ip ?? '1.2.3.4' };
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  if (o.runner) headers.Authorization = 'Bearer ' + RUNNER;
  if (o.origin) headers.Origin = o.origin;
  const res = await handle(new Request('https://fw.example' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, o.now ?? NOW);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function signIn() {
  const r = await call('POST', '/api/login', { password: PASSWORD });
  assert.equal(r.status, 200);
  return r.body.token as string;
}

function flight(a: string, b: string, day: string, n = 'AC1') {
  return { departure_airport: { id: a, time: `${day} 08:00` }, arrival_airport: { id: b, time: `${day} 12:00` }, flight_number: n, airline: 'Air Canada' };
}
function leg(day: string, ...airports: string[]): Leg {
  const flights = airports.slice(0, -1).map((a, i) => flight(a, airports[i + 1], day));
  return { price: 0, flights, layovers: airports.slice(1, -1).map((id) => ({ id, duration: 120 })) };
}
const option = (price: number, out: Leg, back: Leg | null) => ({ price, out, back, airlines: ['AC'] });

const WATCH = {
  name: 'India trip', origin: 'YVR', destination: 'DEL', currency: 'CAD', adults: 1, children: 0, cabin: 1, maxStops: 1, maxLayover: 360,
  outDates: { from: '2026-12-20', to: '2026-12-22' }, backDates: { from: '2027-01-05', to: '2027-01-06' },
  blockedCountries: ['US'], airlines: [], budget: 2500, reserve: 100, bags: 1, allowUnverifiedBags: true, pairsPerRun: 2, enabled: true,
};

beforeEach(() => {
  env = { DB: createD1(), ADMIN_PASSWORD: PASSWORD, RUNNER_TOKEN: RUNNER };
});

describe('rules', () => {
  const rules = { ...validateWatch(WATCH, NOW) };
  test('US layover is blocked, other layovers pass', () => {
    assert.equal(acceptableLeg(leg('2026-12-20', 'YVR', 'SEA', 'DEL'), rules, 'YVR', 'DEL', '2026-12-20'), false);
    assert.equal(acceptableLeg(leg('2026-12-20', 'YVR', 'HKG', 'DEL'), rules, 'YVR', 'DEL', '2026-12-20'), true);
  });
  test('unknown layover airport fails closed when a list is set', () => {
    assert.equal(acceptableLeg(leg('2026-12-20', 'YVR', 'QQQ', 'DEL'), rules, 'YVR', 'DEL', '2026-12-20'), false);
    assert.equal(acceptableLeg(leg('2026-12-20', 'YVR', 'QQQ', 'DEL'), { ...rules, blockedCountries: [] }, 'YVR', 'DEL', '2026-12-20'), true);
  });
  test('wrong date, too many stops, long layover are rejected', () => {
    assert.equal(acceptableLeg(leg('2026-12-21', 'YVR', 'HKG', 'DEL'), rules, 'YVR', 'DEL', '2026-12-20'), false);
    assert.equal(acceptableLeg(leg('2026-12-20', 'YVR', 'HKG', 'BKK', 'DEL'), rules, 'YVR', 'DEL', '2026-12-20'), false);
    const long = leg('2026-12-20', 'YVR', 'HKG', 'DEL');
    long.layovers[0].duration = 360;
    assert.equal(acceptableLeg(long, rules, 'YVR', 'DEL', '2026-12-20'), false);
  });
  test('combos skip past dates and returns before leaving', () => {
    assert.equal(combos({ from: '2026-11-16', to: '2026-11-18' }, null, '2026-11-17').length, 2);
    assert.deepEqual(combos({ from: '2026-12-20', to: '2026-12-21' }, { from: '2026-12-20', to: '2026-12-20' }, '2026-11-17'), [{ out: '2026-12-20', back: '2026-12-20' }]);
  });
  test('watch limits', () => {
    assert.throws(() => validateWatch({ ...WATCH, adults: 5, children: 2 }, NOW), InputError);
    assert.throws(() => validateWatch({ ...WATCH, reserve: 2500 }, NOW), InputError);
    assert.throws(() => validateWatch({ ...WATCH, outDates: { from: '2026-12-01', to: '2027-02-15' } }, NOW), InputError);
    assert.throws(() => validateWatch({ ...WATCH, outDates: { from: '2026-12-01', to: '2026-12-11' }, backDates: { from: '2026-12-20', to: '2026-12-30' } }, NOW), /limit is 100/);
    assert.throws(() => validateWatch({ ...WATCH, outDates: { from: '2026-10-01', to: '2026-10-02' } }, NOW), /No future/);
    assert.throws(() => validateWatch({ ...WATCH, blockedCountries: ['USA'] }, NOW), InputError);
  });
});

describe('login', () => {
  test('wrong password, then lock-out after 5 tries', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
    assert.equal((await call('POST', '/api/login', { password: PASSWORD })).status, 429);
    assert.equal((await call('POST', '/api/login', { password: PASSWORD }, { ip: '9.9.9.9' })).status, 200);
  });
  test('session works, logout ends it, new password ends all sessions', async () => {
    const token = await signIn();
    assert.equal((await call('GET', '/api/watches', undefined, { token })).status, 200);
    assert.equal((await call('GET', '/api/watches')).status, 401);
    env.ADMIN_PASSWORD = 'a different password';
    assert.equal((await call('GET', '/api/watches', undefined, { token })).status, 401);
    env.ADMIN_PASSWORD = PASSWORD;
    assert.equal((await call('POST', '/api/logout', undefined, { token })).status, 200);
    assert.equal((await call('GET', '/api/watches', undefined, { token })).status, 401);
  });
  test('short server password is refused', async () => {
    env.ADMIN_PASSWORD = 'short';
    assert.equal((await call('POST', '/api/login', { password: 'short' })).status, 503);
  });
  test('runner token cannot use app routes and app token cannot use runner routes', async () => {
    const token = await signIn();
    assert.equal((await call('GET', '/api/watches', undefined, { runner: true })).status, 401);
    assert.equal((await call('POST', '/api/runner/job', {}, { token })).status, 401);
  });
});

describe('CORS', () => {
  test('app origin is allowed, others are refused', async () => {
    const ok = await call('GET', '/api/health', undefined, { origin: APP_ORIGIN });
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN);
    assert.equal((await call('GET', '/api/health', undefined, { origin: 'https://evil.example' })).status, 403);
  });
});

describe('settings', () => {
  test('default list is US; update and read back', async () => {
    const token = await signIn();
    assert.deepEqual((await call('GET', '/api/settings', undefined, { token })).body.blockedCountries, ['US']);
    await call('PUT', '/api/settings', { blockedCountries: ['us', 'GB'], currency: 'cad', alertEmail: 'me@example.com' }, { token });
    const s = (await call('GET', '/api/settings', undefined, { token })).body;
    assert.deepEqual(s, { blockedCountries: ['GB', 'US'], currency: 'CAD', alertEmail: 'me@example.com' });
  });
});

describe('watches and runner', () => {
  test('full cycle: create, lease, report, server re-check, read back', async () => {
    const token = await signIn();
    const created = await call('POST', '/api/watches', WATCH, { token });
    assert.equal(created.status, 201);
    const id = created.body.id;

    assert.equal((await call('POST', '/api/runner/due', {}, { runner: true })).body.due, true);
    const job = (await call('POST', '/api/runner/job', {}, { runner: true })).body;
    assert.equal(job.watchId, id);
    assert.deepEqual(job.pairs, [{ out: '2026-12-20', back: '2027-01-05' }, { out: '2026-12-20', back: '2027-01-06' }]);
    assert.equal(job.config.name, undefined); // runner never sees names or budgets
    assert.equal(job.config.budget, undefined);
    assert.deepEqual(job.config.blockedCountries, ['US']);
    // Leased: a second runner gets nothing.
    assert.ok((await call('POST', '/api/runner/job', {}, { runner: true })).body.skip);

    const viaUs = option(900, leg('2026-12-20', 'YVR', 'SEA', 'DEL'), leg('2027-01-05', 'DEL', 'HKG', 'YVR'));
    const good = option(2100, leg('2026-12-20', 'YVR', 'HKG', 'DEL'), leg('2027-01-05', 'DEL', 'HKG', 'YVR'));
    const report = await call('POST', '/api/runner/report', {
      runId: job.runId, errorCount: 1,
      cells: [
        { out: '2026-12-20', back: '2027-01-05', status: 'ok', options: [viaUs, good] },
        { out: '2026-12-20', back: '2027-01-06', status: 'error', options: [], message: 'Google error' },
      ],
    }, { runner: true });
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.match(report.body.message, /1 with prices.*1 failed.*1 itineraries removed by server checks/);
    // Resending the same report is safe.
    assert.equal((await call('POST', '/api/runner/report', { runId: job.runId, cells: [] }, { runner: true })).status, 200);

    const detail = (await call('GET', `/api/watches/${id}`, undefined, { token })).body;
    assert.equal(detail.prices.length, 1);
    assert.equal(detail.prices[0].price, 2100); // the cheaper US-layover fare was removed
    assert.equal(detail.prices[0].options[0].out.layovers[0].country, 'HK');
    assert.equal(detail.watch.bestPrice, 2100);
    assert.equal(detail.watch.underBudget, true); // 2100 + 100 reserve <= 2500
    assert.equal(detail.combos.length, 6);
    assert.equal(detail.runs.length, 1);

    // Checked recently: not due; due again after 50 minutes, continuing at the next dates.
    assert.equal((await call('POST', '/api/runner/due', {}, { runner: true })).body.due, false);
    const next = (await call('POST', '/api/runner/job', {}, { runner: true, now: NOW + 51 * MIN })).body;
    assert.deepEqual(next.pairs[0], { out: '2026-12-21', back: '2027-01-05' });

    const status = (await call('GET', '/api/status', undefined, { token })).body.runner;
    assert.equal(status.lastOkAt, NOW);
  });

  test('report with dates that were not leased is refused', async () => {
    const token = await signIn();
    await call('POST', '/api/watches', WATCH, { token });
    const job = (await call('POST', '/api/runner/job', {}, { runner: true })).body;
    const r = await call('POST', '/api/runner/report', { runId: job.runId, cells: [{ out: '2026-12-22', back: '2027-01-05', status: 'none', options: [] }] }, { runner: true });
    assert.equal(r.status, 409);
  });

  test('editing search settings clears prices and discards an in-flight report', async () => {
    const token = await signIn();
    const id = (await call('POST', '/api/watches', WATCH, { token })).body.id;
    const job = (await call('POST', '/api/runner/job', {}, { runner: true })).body;
    const edit = await call('PUT', `/api/watches/${id}`, { ...WATCH, maxStops: 2 }, { token });
    assert.equal(edit.body.pricesCleared, true);
    const r = await call('POST', '/api/runner/report', { runId: job.runId, cells: [] }, { runner: true });
    assert.equal(r.status, 409);
    // Name / budget edits keep prices.
    assert.equal((await call('PUT', `/api/watches/${id}`, { ...WATCH, maxStops: 2, name: 'Renamed', budget: 3000 }, { token })).body.pricesCleared, false);
  });

  test('pause, limits and delete', async () => {
    const token = await signIn();
    const id = (await call('POST', '/api/watches', WATCH, { token })).body.id;
    await call('PATCH', `/api/watches/${id}`, { enabled: false }, { token });
    assert.equal((await call('POST', '/api/runner/due', {}, { runner: true })).body.due, false);
    for (let i = 0; i < 9; i++) await call('POST', '/api/watches', WATCH, { token });
    assert.equal((await call('POST', '/api/watches', WATCH, { token })).status, 409);
    assert.equal((await call('DELETE', `/api/watches/${id}`, undefined, { token })).status, 200);
    assert.equal((await call('GET', `/api/watches/${id}`, undefined, { token })).status, 404);
    assert.equal((await call('GET', '/api/watches', undefined, { token })).body.watches.length, 9);
  });

  test('expired lease cannot report', async () => {
    const token = await signIn();
    await call('POST', '/api/watches', WATCH, { token });
    const job = (await call('POST', '/api/runner/job', {}, { runner: true })).body;
    const r = await call('POST', '/api/runner/report', { runId: job.runId, cells: [] }, { runner: true, now: NOW + 31 * MIN });
    assert.equal(r.status, 409);
  });
});

describe('saved lookups', () => {
  test('save, list, read, delete', async () => {
    const token = await signIn();
    const request = { ...WATCH, outDates: { from: '2026-12-20', to: '2026-12-20' }, backDates: { from: '2027-01-05', to: '2027-01-06' } };
    const good = option(2200, leg('2026-12-20', 'YVR', 'HKG', 'DEL'), leg('2027-01-05', 'DEL', 'HKG', 'YVR'));
    const saved = await call('POST', '/api/lookups', {
      request, complete: true,
      cells: [
        { out: '2026-12-20', back: '2027-01-05', status: 'ok', options: [{ ...good, extra: 'dropped' }] },
        { out: '2026-12-20', back: '2027-01-06', status: 'none', options: [] },
      ],
    }, { token });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const list = (await call('GET', '/api/lookups', undefined, { token })).body.lookups;
    assert.equal(list[0].bestPrice, 2200);
    const one = (await call('GET', `/api/lookups/${saved.body.id}`, undefined, { token })).body;
    assert.equal(one.cells.length, 2);
    assert.equal(one.cells[0].options[0].extra, undefined);
    assert.equal(one.combos.length, 2);
    assert.equal((await call('DELETE', `/api/lookups/${saved.body.id}`, undefined, { token })).status, 200);
  });
  test('cells outside the lookup dates are refused', async () => {
    const token = await signIn();
    const request = { ...WATCH, outDates: { from: '2026-12-20', to: '2026-12-20' }, backDates: null };
    const r = await call('POST', '/api/lookups', { request, cells: [{ out: '2026-12-25', back: null, status: 'none', options: [] }] }, { token });
    assert.equal(r.status, 400);
  });
});
