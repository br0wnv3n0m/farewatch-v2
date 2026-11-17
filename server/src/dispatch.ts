// Starts the GitHub "Watch check" workflow from the Worker cron when a watch is due.
//
// Why: GitHub runs scheduled workflows on free public repos late or not at all
// (in Nov 2026 the 15-minute schedule fired about once in 10 hours). The Worker
// cron is reliable, so it asks GitHub to run the workflow (workflow_dispatch).
// GitHub's own schedule stays on as a backup; watch leases stop double checks.
//
// Needs the secret GITHUB_TOKEN: a fine-grained token for this one repo with
// "Actions: Read and write" only. Without it, nothing happens here.
import type { Env } from './http.ts';
import { isWatchDue } from './runner.ts';

export const GITHUB_REPO = 'br0wnv3n0m/farewatch-v2';
const WORKFLOW = 'watch.yml';
const MINUTE = 60_000;
/** Skip when the runner asked for work this recently: it is already active. */
export const RECENT_POLL = 20 * MINUTE;
/** At most one start request per this time (a run takes up to ~30 min). */
export const DISPATCH_GAP = 25 * MINUTE;

/** Returns what happened, for logs and tests. */
export async function dispatchIfDue(env: Env, now: number): Promise<'no-token' | 'not-due' | 'recent' | 'sent' | 'failed'> {
  if (!env.GITHUB_TOKEN) return 'no-token';
  const db = env.DB;
  if (!(await isWatchDue(db, now))) return 'not-due';
  const s = await db.prepare('SELECT last_poll_at, dispatch_at FROM runner_status WHERE id = 1').first<{ last_poll_at: number; dispatch_at: number }>();
  if (s && (now - s.last_poll_at < RECENT_POLL || now - s.dispatch_at < DISPATCH_GAP)) return 'recent';

  let error: string | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'farewatch-v2-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status !== 204 && res.status !== 200) {
      const hint = res.status === 401 ? ' The GITHUB_TOKEN secret is wrong or expired.'
        : res.status === 403 || res.status === 404 ? ' The GITHUB_TOKEN needs "Actions: Read and write" on farewatch-v2.' : '';
      error = `GitHub refused to start the workflow (HTTP ${res.status}).${hint}`;
    }
  } catch {
    error = 'Could not reach GitHub to start the workflow.';
  }
  await db.prepare('UPDATE runner_status SET dispatch_at = ?, dispatch_error = ? WHERE id = 1').bind(now, error).run();
  if (error) console.error(error);
  return error ? 'failed' : 'sent';
}
