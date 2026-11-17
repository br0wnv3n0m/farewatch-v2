// Runner API for GitHub Actions (token: RUNNER_TOKEN).
//   POST /api/runner/due    -> {due}            cheap check before installing Python
//   POST /api/runner/job    -> lease one watch: {runId, watchId, config, pairs} or {skip}
//   POST /api/runner/report -> results for the leased dates; checked again here
// The runner only ever sees search rules and dates: no names, budgets or emails.
import { type Ctx, HttpError, json, readJson } from './http.ts';
import {
  asObject, type CellOption, type Combo, combos, InputError, LIMITS, optionAllowed, sanitizeOption, type SearchRules, todayUtc,
} from './rules.ts';
import { sendFareAlerts } from './alerts.ts';
import { alertStatus } from './monitor.ts';
import { loadWatches, type WatchRow } from './watches.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A watch is checked again once this much time has passed (cron runs every 15 min). */
export const RECHECK_AFTER = 50 * MINUTE;
/** How long a runner may hold a watch before the lease lapses. */
export const LEASE = 30 * MINUTE;

const searchConfig = (w: SearchRules): SearchRules => ({
  origin: w.origin, destination: w.destination, currency: w.currency, adults: w.adults, children: w.children, cabin: w.cabin,
  maxStops: w.maxStops, maxLayover: w.maxLayover, maxOutboundTries: w.maxOutboundTries,
  blockedCountries: w.blockedCountries, airlines: w.airlines,
});

/** POST /api/runner/due {commitAt?} - commitAt: Unix seconds of the repo's newest commit (GitHub's 60-day pause). */
export async function runnerDue(ctx: Ctx): Promise<Response> {
  const { env, now } = ctx;
  const body = asObject(await readJson(ctx.request, 1024));
  const commitAt = body.commitAt;
  const commitMs = Number.isSafeInteger(commitAt) && (commitAt as number) > 1.5e9 && (commitAt as number) * 1000 < now + DAY ? (commitAt as number) * 1000 : 0;
  await env.DB.prepare('UPDATE runner_status SET last_poll_at = ?, repo_commit_at = MAX(repo_commit_at, ?) WHERE id = 1').bind(now, commitMs).run();
  return json({ due: await isWatchDue(env.DB, now) });
}

/** True when an enabled watch is free and has not been checked for RECHECK_AFTER. Also used by the cron (dispatch.ts). */
export async function isWatchDue(db: D1Database, now: number): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM watches WHERE enabled = 1 AND lease_until < ? AND last_checked_at < ? LIMIT 1')
    .bind(now, now - RECHECK_AFTER).first();
  return !!row;
}

/** POST /api/runner/job {exclude?: number[]} */
export async function runnerJob(ctx: Ctx): Promise<Response> {
  const { env, now } = ctx;
  const db = env.DB;
  const body = asObject(await readJson(ctx.request, 2048));
  const exclude = body.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.length > LIMITS.maxWatches || exclude.some((x) => !Number.isSafeInteger(x)))
    throw new InputError('exclude must be a list of watch ids.');

  await db.prepare('UPDATE runner_status SET last_poll_at = ? WHERE id = 1').bind(now).run();
  const today = todayUtc(now);
  const due = (await loadWatches(db))
    .filter(({ row }) => row.enabled === 1 && row.lease_until < now && row.last_checked_at < now - RECHECK_AFTER && !exclude.includes(row.id))
    .sort((a, b) => a.row.last_checked_at - b.row.last_checked_at || a.row.id - b.row.id);

  for (const { row, input } of due) {
    const list = combos(input.outDates, input.backDates, today);
    if (!list.length) continue; // every date is in the past; the app shows this
    const runId = crypto.randomUUID();
    const claimed = await db
      .prepare('UPDATE watches SET lease_run_id = ?, lease_until = ? WHERE id = ? AND revision = ? AND lease_until < ?')
      .bind(runId, now + LEASE, row.id, row.revision, now)
      .run();
    if (!claimed.meta.changes) continue; // someone else took it
    const start = row.cursor % list.length;
    const pairs = Array.from({ length: Math.min(input.pairsPerRun, list.length) }, (_, i) => list[(start + i) % list.length]);
    await db.batch([
      db.prepare('INSERT INTO runner_jobs (id, watch_id, revision, start_cursor, combo_count, leased_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(runId, row.id, row.revision, start, list.length, now, now + LEASE),
      ...pairs.map((p, i) =>
        db.prepare('INSERT INTO runner_job_pairs (job_id, position, out_date, back_date) VALUES (?, ?, ?, ?)').bind(runId, i, p.out, p.back ?? '')),
    ]);
    return json({ runId, watchId: row.id, config: searchConfig(input), pairs });
  }
  return json({ skip: 'No watch is due right now.' });
}

interface JobRow {
  id: string;
  watch_id: number;
  revision: number;
  start_cursor: number;
  expires_at: number;
  state: string;
  message: string | null;
}

interface CheckedCell {
  combo: Combo;
  status: 'ok' | 'none' | 'error';
  options: CellOption[];
  message?: string;
  rejected: number; // options removed by the server checks
}

const shortText = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** Validate one reported cell against the leased dates and the watch rules. */
function checkCell(raw: unknown, expected: Combo, rules: SearchRules): CheckedCell {
  const c = asObject(raw, 'cell');
  if (c.out !== expected.out || (c.back ?? null) !== expected.back) throw new HttpError(409, 'Report does not match the leased dates.');
  if (c.status === 'error') return { combo: expected, status: 'error', options: [], message: shortText(c.message) ?? 'Search failed.', rejected: 0 };
  if (c.status !== 'ok' && c.status !== 'none') throw new InputError('cell.status must be ok, none or error.');
  const raws = Array.isArray(c.options) ? c.options : [];
  if (raws.length > LIMITS.maxOptionsPerCell) throw new InputError('Too many options in a cell.');
  const kept: CellOption[] = [];
  let rejected = 0;
  for (const r of raws) {
    try {
      const o = sanitizeOption(r, expected.back !== null);
      if (optionAllowed(o, rules, expected)) kept.push(o);
      else rejected++;
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      rejected++;
    }
  }
  kept.sort((a, b) => a.price - b.price);
  const options = kept.slice(0, LIMITS.storedWatchOptions);
  return { combo: expected, status: options.length ? 'ok' : 'none', options, rejected };
}

/** POST /api/runner/report {runId, cells:[{out,back,status,options,message}], errorCount, fatal?} */
export async function runnerReport(ctx: Ctx): Promise<Response> {
  const { env, now } = ctx;
  const db = env.DB;
  const body = asObject(await readJson(ctx.request, 1_000_000));
  if (typeof body.runId !== 'string' || body.runId.length > 64) throw new InputError('Missing runId.');
  const job = await db.prepare('SELECT * FROM runner_jobs WHERE id = ?').bind(body.runId).first<JobRow>();
  if (!job) throw new HttpError(404, 'Unknown runner job.');
  if (job.state === 'done') return json({ message: job.message ?? 'Already reported.' }); // safe to resend
  if (job.state !== 'leased') throw new HttpError(409, 'This report is already being processed.');
  if (job.expires_at < now) throw new HttpError(409, 'This runner job expired. The watch will be checked in a later run.');

  const [found] = await loadWatches(db, job.watch_id);
  const row: WatchRow | undefined = found?.row;
  if (!found || !row || row.revision !== job.revision || row.lease_run_id !== job.id) {
    await db.prepare("UPDATE runner_jobs SET state = 'done', message = ? WHERE id = ? AND state = 'leased'")
      .bind('Discarded: the watch was changed or deleted during the check.', job.id).run();
    throw new HttpError(409, 'The watch was changed during the check; results were discarded.');
  }

  const leased = await db.prepare('SELECT out_date, back_date FROM runner_job_pairs WHERE job_id = ? ORDER BY position').bind(job.id)
    .all<{ out_date: string; back_date: string }>();
  const expected: Combo[] = leased.results.map((p) => ({ out: p.out_date, back: p.back_date || null }));
  const rawCells = Array.isArray(body.cells) ? body.cells : null;
  if (!rawCells || rawCells.length > expected.length) throw new InputError('cells must be a list no longer than the leased dates.');
  const errorCount = body.errorCount ?? 0;
  if (typeof errorCount !== 'number' || !Number.isInteger(errorCount) || errorCount < 0) throw new InputError('errorCount must be a whole number.');
  const fatal = shortText(body.fatal);

  // Leased dates are reported in order; a run that stopped early reports a prefix.
  const cells = rawCells.map((c, i) => checkCell(c, expected[i], found.input));

  const claim = await db.prepare("UPDATE runner_jobs SET state = 'processing' WHERE id = ? AND state = 'leased'").bind(job.id).run();
  if (!claim.meta.changes) throw new HttpError(409, 'This report is already being processed.');

  const priced = cells.filter((c) => c.status === 'ok').length;
  const none = cells.filter((c) => c.status === 'none').length;
  const failed = cells.filter((c) => c.status === 'error').length;
  const rejected = cells.reduce((n, c) => n + c.rejected, 0);
  const firstError = fatal ?? cells.find((c) => c.message)?.message ?? null;
  const message =
    `Checked ${cells.length} of ${expected.length} date combinations: ${priced} with prices, ${none} with no allowed flight, ${failed} failed.` +
    (rejected ? ` ${rejected} itineraries removed by server checks.` : '') +
    (fatal ? ` Stopped: ${fatal}` : '');

  const today = todayUtc(now);
  const comboCount = combos(found.input.outDates, found.input.backDates, today).length;
  const nextCursor = comboCount ? (job.start_cursor + cells.length) % comboCount : 0;
  const statements: D1PreparedStatement[] = [];
  for (const c of cells) {
    if (c.status === 'error') continue; // keep the last good price
    const back = c.combo.back ?? '';
    const best = c.options[0]?.price ?? null;
    statements.push(
      db.prepare(
        `INSERT INTO watch_prices (watch_id, revision, out_date, back_date, status, price, options_json, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (watch_id, out_date, back_date) DO UPDATE SET revision = excluded.revision, status = excluded.status,
           price = excluded.price, options_json = excluded.options_json, checked_at = excluded.checked_at`,
      ).bind(row.id, row.revision, c.combo.out, back, c.status, best, JSON.stringify(c.options), now),
    );
    if (best !== null)
      statements.push(
        db.prepare('INSERT INTO price_history (watch_id, revision, out_date, back_date, price, airlines, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(row.id, row.revision, c.combo.out, back, best, c.options[0].airlines.join(','), now),
      );
  }
  statements.push(
    db.prepare('UPDATE watches SET cursor = ?, last_checked_at = ?, lease_run_id = NULL, lease_until = 0 WHERE id = ? AND lease_run_id = ?')
      .bind(nextCursor, now, row.id, job.id),
    db.prepare('INSERT INTO watch_runs (watch_id, at, checked, found, errors, message) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(row.id, now, cells.length, priced, Math.max(failed, errorCount), message),
    db.prepare("UPDATE runner_jobs SET state = 'done', message = ? WHERE id = ?").bind(message, job.id),
    db.prepare('UPDATE runner_status SET last_report_at = ?, last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END, last_error = ? WHERE id = 1')
      .bind(now, priced + none > 0 ? 1 : 0, now, firstError),
    // Keep the newest 100 runs. Other clean-up runs in the cron (monitor.ts).
    db.prepare('DELETE FROM watch_runs WHERE watch_id = ? AND id NOT IN (SELECT id FROM watch_runs WHERE watch_id = ? ORDER BY id DESC LIMIT 100)').bind(row.id, row.id),
  );
  try {
    await db.batch(statements);
  } catch (err) {
    await db.prepare("UPDATE runner_jobs SET state = 'leased' WHERE id = ?").bind(job.id).run();
    throw err;
  }
  // Fare alert email. A failure never fails the report; the cron retries within 30 minutes.
  let emailed = '';
  try {
    const r = await sendFareAlerts(env, row.id, now);
    if (r) emailed = r.ok ? ' Alert email sent.' : ' Alert email failed; it will be retried.';
  } catch (err) {
    console.error('fare alert failed', err);
  }
  return json({ message: message + emailed });
}

/** GET /api/status (app): when the runner last polled / reported. */
export async function runnerStatus(ctx: Ctx): Promise<Response> {
  const s = await ctx.env.DB.prepare('SELECT last_poll_at, last_report_at, last_ok_at, last_error FROM runner_status WHERE id = 1')
    .first<{ last_poll_at: number; last_report_at: number; last_ok_at: number; last_error: string | null }>();
  return json({
    alerts: await alertStatus(ctx.env),
    runner: {
      lastPollAt: s?.last_poll_at || null,
      lastReportAt: s?.last_report_at || null,
      lastOkAt: s?.last_ok_at || null,
      lastError: s?.last_error ?? null,
    },
  });
}
