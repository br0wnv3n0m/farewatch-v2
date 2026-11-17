// "Checks have stopped" monitor and clean-up. Runs from the Worker cron every 30 minutes.
//
// There is no backup flight engine, so silence must be noticed:
//   - the runner has not asked for work for 3 hours  (GitHub cron runs every 15 min; it is often late, rarely 3 h)
//   - no successful search for 6 hours while a watch is active (blocked, broken scraper, failing reports)
//   - GitHub pauses scheduled workflows in a public repo after 60 days without commits:
//     a warning email at 50 days, and the "stopped" email names this case when it happens.
// One email when a problem starts, a reminder every 3 days while it lasts, one when checks work again.
import { sendFareAlerts } from './alerts.ts';
import { emailBlocker, emailLayout, esc, logEmail, sendEmail, type EmailKind } from './email.ts';
import type { Env } from './http.ts';
import { combos, todayUtc } from './rules.ts';
import { loadSettings } from './settings.ts';
import { loadWatches } from './watches.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const POLL_LIMIT = 3 * HOUR;
export const OK_LIMIT = 6 * HOUR;
export const REMIND_EVERY = 3 * DAY;
export const REPO_PAUSE_DAYS = 60;
export const REPO_WARN_DAYS = 50;
const REPO_URL = 'https://github.com/br0wnv3n0m/farewatch-v2';

export interface MonitorRow {
  last_poll_at: number;
  last_report_at: number;
  last_ok_at: number;
  last_error: string | null;
  repo_commit_at: number;
  repo_alert_at: number;
  outage_since: number;
  outage_reason: string | null;
  outage_emailed_at: number;
}

export async function loadMonitor(db: D1Database): Promise<MonitorRow> {
  return (await db.prepare('SELECT * FROM runner_status WHERE id = 1').first<MonitorRow>())!;
}

const hoursText = (ms: number) => (ms >= 48 * HOUR ? `${Math.round(ms / DAY)} days` : `${Math.round(ms / HOUR)} hours`);

/** Problem text, or null when checks look fine. `activeSince` = when watching last became active. */
export function findProblem(s: MonitorRow, activeSince: number | null, now: number): string | null {
  if (activeSince === null) return null; // no active watch: the runner has nothing to do
  const repoDays = s.repo_commit_at ? (now - s.repo_commit_at) / DAY : 0;
  if (s.last_poll_at && now - s.last_poll_at > POLL_LIMIT) {
    const paused = repoDays >= REPO_PAUSE_DAYS - 1;
    return `The GitHub workflow has not asked for work for ${hoursText(now - s.last_poll_at)}.` +
      (paused ? ` The repo has had no commit for ${Math.floor(repoDays)} days, so GitHub has most likely paused the schedule.` : '');
  }
  const okRef = Math.max(s.last_ok_at, activeSince);
  if (now - okRef > OK_LIMIT)
    return `No successful flight search for ${hoursText(now - okRef)}.` + (s.last_error ? ` Last problem: ${s.last_error}` : '');
  return null;
}

/** When the watches last became active (newest change to an enabled watch with future dates), or null. */
async function activeSince(db: D1Database, now: number): Promise<number | null> {
  const today = todayUtc(now);
  const active = (await loadWatches(db)).filter(({ row, input }) => row.enabled === 1 && combos(input.outDates, input.backDates, today).length > 0);
  if (!active.length) return null;
  return Math.max(...active.map(({ row }) => row.updated_at));
}

function monitorEmail(kind: 'stopped' | 'resumed' | 'repo', detail: string, now: number, s: MonitorRow) {
  const fix = `<p style="font-size:14px"><strong>What to do</strong></p><ol style="font-size:14px;line-height:1.5;padding-left:18px">
<li>Open <a href="${REPO_URL}/actions" style="color:#16a34a">GitHub → farewatch-v2 → Actions</a>.</li>
<li>If you see "This scheduled workflow is disabled", click <strong>Enable workflow</strong>.</li>
<li>Click <strong>Watch check → Run workflow</strong> and open the run to see any error.</li>
<li>Any commit to the repo restarts GitHub's 60-day timer.</li></ol>`;
  const last = `Last request ${new Date(s.last_poll_at || now).toISOString().slice(0, 16).replace('T', ' ')} UTC · last successful search ${s.last_ok_at ? new Date(s.last_ok_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}.`;
  const content = {
    stopped: { subject: 'Farewatch: watch checks have stopped', head: 'Watch checks have stopped', body: `<p style="font-size:14px">${esc(detail)}</p>${fix}<p style="font-size:12px;color:#5d6f65">${esc(last)}</p>` },
    resumed: { subject: 'Farewatch: watch checks are working again', head: 'Watch checks are working again', body: `<p style="font-size:14px">${esc(detail)}</p>` },
    repo: { subject: 'Farewatch: GitHub will pause watch checks soon', head: 'GitHub will pause watch checks soon', body: `<p style="font-size:14px">${esc(detail)}</p><p style="font-size:14px">Push any commit to <a href="${REPO_URL}" style="color:#16a34a">farewatch-v2</a> to reset the timer (for example, edit README.md on github.com and commit).</p>` },
  }[kind];
  const html = emailLayout(content.subject, `<h1 style="font-size:20px">${esc(content.head)}</h1>${content.body}`, 'Sent by the Farewatch watch server. Settings in the app show the same status.');
  const text = `${content.head}\n\n${detail}\n\n${kind === 'stopped' ? `Fix: open ${REPO_URL}/actions. If the workflow is disabled, click "Enable workflow". Then run "Watch check" by hand and read the log.\n${last}` : kind === 'repo' ? `Push any commit to ${REPO_URL} to reset the timer.` : ''}`;
  return { subject: content.subject, html, text };
}

async function notify(env: Env, now: number, kind: Extract<EmailKind, 'stopped' | 'resumed' | 'repo'>, detail: string, s: MonitorRow, keyPart: string): Promise<boolean> {
  const settings = await loadSettings(env.DB);
  if (emailBlocker(env, settings.alertEmail)) return false;
  const r = await sendEmail(env, { to: settings.alertEmail!, ...monitorEmail(kind, detail, now, s) }, `fw2-${kind}-${keyPart}`);
  await logEmail(env.DB, now, kind, null, { ok: r.ok, message: r.ok ? detail : r.message });
  return r.ok;
}

/** Check the runner and email on changes. Exported for tests. */
export async function runMonitor(env: Env, now: number): Promise<void> {
  const db = env.DB;
  const s = await loadMonitor(db);
  const problem = findProblem(s, await activeSince(db, now), now);

  if (problem) {
    const since = s.outage_since || now;
    const due = !s.outage_emailed_at || now - s.outage_emailed_at > REMIND_EVERY;
    const sent = due ? await notify(env, now, 'stopped', problem, s, `${since}-${s.outage_emailed_at}`) : false;
    await db.prepare('UPDATE runner_status SET outage_since = ?, outage_reason = ?, outage_emailed_at = ? WHERE id = 1')
      .bind(since, problem, sent ? now : s.outage_emailed_at).run();
  } else if (s.outage_since) {
    if (s.outage_emailed_at) await notify(env, now, 'resumed', `Checks were down for ${hoursText(now - s.outage_since)} and are running again.`, s, `${s.outage_since}`);
    await db.prepare('UPDATE runner_status SET outage_since = 0, outage_reason = NULL, outage_emailed_at = 0 WHERE id = 1').run();
  }

  // GitHub's 60-day pause: warn ahead of time (weekly while it applies).
  const repoDays = s.repo_commit_at ? (now - s.repo_commit_at) / DAY : 0;
  if (repoDays >= REPO_WARN_DAYS && repoDays < REPO_PAUSE_DAYS && now - s.repo_alert_at > 7 * DAY) {
    const left = Math.max(1, Math.ceil(REPO_PAUSE_DAYS - repoDays));
    const sent = await notify(env, now, 'repo', `The farewatch-v2 repo has had no commit for ${Math.floor(repoDays)} days. GitHub pauses scheduled workflows in public repos after 60 days, in about ${left} day${left > 1 ? 's' : ''}.`, s, `${s.repo_commit_at}`);
    if (sent) await db.prepare('UPDATE runner_status SET repo_alert_at = ? WHERE id = 1').bind(now).run();
  }
}

/** Remove old rows. Indexed deletes (migration 0002), cheap enough to run every 30 minutes. */
export async function cleanUp(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM watch_prices WHERE out_date < ?').bind(todayUtc(now)),
    db.prepare('DELETE FROM price_history WHERE at < ?').bind(now - 365 * DAY),
    db.prepare('DELETE FROM runner_job_pairs WHERE job_id IN (SELECT id FROM runner_jobs WHERE leased_at < ?)').bind(now - 7 * DAY),
    db.prepare('DELETE FROM runner_jobs WHERE leased_at < ?').bind(now - 7 * DAY),
    db.prepare('DELETE FROM fare_links WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - DAY),
  ]);
}

/** Cron entry: clean-up, retry any fare alert that failed, then the monitor. Each part runs even if another fails. */
export async function scheduled(env: Env, now: number): Promise<void> {
  const parts: [string, () => Promise<unknown>][] = [
    ['clean-up', () => cleanUp(env.DB, now)],
    ['fare alerts', async () => {
      for (const { row } of await loadWatches(env.DB)) if (row.enabled === 1) await sendFareAlerts(env, row.id, now);
    }],
    ['monitor', () => runMonitor(env, now)],
  ];
  for (const [name, fn] of parts) {
    try {
      await fn();
    } catch (err) {
      console.error(`cron ${name} failed`, err);
    }
  }
}

/** Email + monitor status for the app (GET /api/status). */
export async function alertStatus(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;
  const s = await loadMonitor(db);
  const settings = await loadSettings(db);
  const last = await db.prepare('SELECT at, kind, ok, message FROM email_log ORDER BY id DESC LIMIT 5').all<{ at: number; kind: string; ok: number; message: string }>();
  return {
    emailBlocker: emailBlocker(env, settings.alertEmail),
    outageSince: s.outage_since || null,
    outageReason: s.outage_reason,
    repoCommitAt: s.repo_commit_at || null,
    recentEmails: last.results.map((r) => ({ at: r.at, kind: r.kind, ok: r.ok === 1, message: r.message })),
  };
}
