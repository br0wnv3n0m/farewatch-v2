import { useEffect, useState } from 'react';
import type { RunnerStatus, ServerApi } from '../backend/types';
import { ago } from '../lib/format';

interface Props {
  server: ServerApi;
  /** Called after sign in / sign out so the app reloads settings and watches. */
  onChange: () => void;
}

/** Connect the app to the watch server (Cloudflare Worker) with the app password. */
export function ServerPanel({ server, onChange }: Props) {
  const conn = server.connection();
  const [url, setUrl] = useState(conn.url && conn.url !== 'demo' ? conn.url : '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runner, setRunner] = useState<RunnerStatus | null>(null);

  useEffect(() => {
    if (conn.signedIn) server.runnerStatus().then(setRunner, () => setRunner(null));
  }, [server, conn.signedIn]);

  if (conn.url === 'demo') return <p className="muted small">Demo mode: watches are kept in memory and prices are fake.</p>;

  if (conn.signedIn)
    return (
      <div className="server">
        <p className="small">
          Connected to <strong>{conn.url}</strong>
        </p>
        {runner && (
          <p className={runner.lastError ? 'small warn' : 'small muted'}>
            Watch checks: last request {ago(runner.lastPollAt)}, last result {ago(runner.lastReportAt)}, last successful search {ago(runner.lastOkAt)}.
            {runner.lastError ? ` Last problem: ${runner.lastError}` : ''}
          </p>
        )}
        <button
          className="btn ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await server.signOut();
            setBusy(false);
            onChange();
          }}
        >
          Sign out
        </button>
      </div>
    );

  return (
    <form
      className="server"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await server.signIn(url, password);
          setPassword('');
          onChange();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted small">Watches, saved lookups and settings live on your watch server. Sign in once on each device.</p>
      <div className="row">
        <label className="field grow">
          <span className="label">Server address</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://farewatch-v2.NAME.workers.dev" autoComplete="url" />
        </label>
        <label className="field">
          <span className="label">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <button type="submit" className="btn primary" disabled={busy || !url || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
      {error && <p className="warn small">{error}</p>}
    </form>
  );
}
