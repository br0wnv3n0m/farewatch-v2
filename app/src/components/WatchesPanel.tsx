import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ServerApi, Settings, Watch, WatchDetail, WatchInput } from '../backend/types';
import { ago, money, rangeText } from '../lib/format';
import { airlineNames, cellKey, visibleOptions, type CellState } from '../lib/grid';
import { FlightDetails } from './FlightDetails';
import { PriceHistory } from './PriceHistory';
import { PriceGrid } from './PriceGrid';
import { defaultWatch, WatchForm } from './WatchForm';

type View =
  | { mode: 'list' }
  | { mode: 'form'; id: number | null; initial: WatchInput }
  | { mode: 'detail'; id: number }
  | { mode: 'history'; watch: Watch };

interface Props {
  server: ServerApi;
  settings: Settings;
  /** A watch prepared from the lookup grid ("Watch these dates"). */
  draft: WatchInput | null;
  onDraftUsed: () => void;
  onOpenSettings: () => void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Strip the server-only fields so a Watch can be edited as a WatchInput. */
function toInput(w: Watch): WatchInput {
  const { id: _id, revision: _r, comboCount: _c, pricesChecked: _p, bestPrice: _b, underBudget: _u, lastCheckedAt: _l, checking: _k, createdAt: _cr, updatedAt: _up, ...input } = w;
  return input;
}

export function WatchesPanel({ server, settings, draft, onDraftUsed, onOpenSettings }: Props) {
  const [view, setView] = useState<View>({ mode: 'list' });
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = server.connection().signedIn;

  const reload = useCallback(async () => {
    try {
      setWatches(await server.listWatches());
    } catch (e) {
      setNotice(errorText(e));
    }
  }, [server]);

  useEffect(() => { if (signedIn) void reload(); }, [reload, signedIn]);

  useEffect(() => {
    if (draft) {
      setView({ mode: 'form', id: null, initial: draft });
      onDraftUsed();
    }
  }, [draft, onDraftUsed]);

  const act = async (fn: () => Promise<unknown>, done?: View) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      await reload();
      if (done) setView(done);
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!signedIn)
    return (
      <section className="card">
        <h2>Watches</h2>
        <p className="muted">Watches run on the watch server, so they keep checking while this PC is off. Connect the server first.</p>
        <button className="btn primary" onClick={onOpenSettings}>Open Settings</button>
      </section>
    );

  if (view.mode === 'form')
    return (
      <>
        {notice && <p className="banner warn">{notice}</p>}
        <WatchForm
          key={view.id ?? 'new'}
          initial={view.initial}
          isNew={view.id === null}
          busy={busy}
          onCancel={() => setView(view.id === null ? { mode: 'list' } : { mode: 'detail', id: view.id })}
          onSave={(w) =>
            void act(async () => {
              if (view.id === null) {
                const id = await server.createWatch(w);
                setView({ mode: 'detail', id });
              } else {
                const r = await server.updateWatch(view.id, w);
                if (r.pricesCleared) setNotice('Search settings changed: old prices were cleared. New prices arrive with the next checks.');
                setView({ mode: 'detail', id: view.id });
              }
            })
          }
        />
      </>
    );

  if (view.mode === 'history')
    return <PriceHistory server={server} watch={view.watch} onBack={() => setView({ mode: 'detail', id: view.watch.id })} />;

  if (view.mode === 'detail')
    return (
      <WatchDetailView
        server={server}
        id={view.id}
        notice={notice}
        onBack={() => { setNotice(null); setView({ mode: 'list' }); void reload(); }}
        onEdit={(w) => setView({ mode: 'form', id: w.id, initial: toInput(w) })}
        onHistory={(w) => setView({ mode: 'history', watch: w })}
        onDelete={(w) => {
          if (confirm(`Delete "${w.name}" and all its prices?`)) void act(() => server.deleteWatch(w.id), { mode: 'list' });
        }}
      />
    );

  return (
    <section className="watches">
      <div className="results-bar">
        <h2>Watches</h2>
        <button className="btn primary" disabled={(watches?.length ?? 0) >= 10} onClick={() => setView({ mode: 'form', id: null, initial: defaultWatch(settings.blockedCountries, settings.currency) })}>
          New watch
        </button>
      </div>
      {notice && <p className="banner warn">{notice}</p>}
      {watches === null ? (
        <p className="muted">Loading…</p>
      ) : watches.length === 0 ? (
        <p className="card muted">No watches yet. Create one here, or run a lookup and press “Watch these dates”.</p>
      ) : (
        <div className="watch-list">
          {watches.map((w) => (
            <article key={w.id} className={`card watch-card${w.enabled ? '' : ' paused'}`}>
              <button className="watch-open" onClick={() => setView({ mode: 'detail', id: w.id })}>
                <div className="watch-title">
                  <strong>{w.name}</strong>
                  {w.underBudget && <span className="badge">Under budget</span>}
                  {!w.enabled && <span className="badge muted-badge">Paused</span>}
                </div>
                <div className="muted small">
                  {w.origin} → {w.destination} · leave {rangeText(w.outDates)}
                  {w.backDates ? ` · return ${rangeText(w.backDates)}` : ' · one way'}
                </div>
                <div className="watch-price">
                  <span className="price">{w.bestPrice === null ? '—' : money(w.bestPrice, w.currency)}</span>
                  <span className="muted small"> budget {money(w.budget, w.currency)}</span>
                </div>
                <div className="muted small">
                  {w.pricesChecked}/{w.comboCount} dates checked · last check {ago(w.lastCheckedAt)}
                  {w.checking ? ' · checking now' : ''}
                </div>
              </button>
              <label className="inline">
                <input type="checkbox" checked={w.enabled} disabled={busy} onChange={(e) => void act(() => server.setWatchEnabled(w.id, e.target.checked))} />
                Checking on
              </label>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

interface DetailProps {
  server: ServerApi;
  id: number;
  notice: string | null;
  onBack: () => void;
  onEdit: (w: Watch) => void;
  onHistory: (w: Watch) => void;
  onDelete: (w: Watch) => void;
}

function WatchDetailView({ server, id, notice, onBack, onEdit, onHistory, onDelete }: DetailProps) {
  const [data, setData] = useState<WatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [airline, setAirline] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await server.getWatch(id));
    } catch (e) {
      setError(errorText(e));
    }
  }, [server, id]);
  useEffect(() => { void load(); }, [load]);

  const cells = useMemo(() => {
    const m = new Map<string, CellState>();
    for (const p of data?.prices ?? []) m.set(cellKey(p.out, p.back), { status: p.status, options: p.options });
    return m;
  }, [data]);
  const names = useMemo(() => airlineNames(cells), [cells]);
  const cheapest = useMemo(() => {
    let best: [string, number] | null = null;
    for (const [k, c] of cells) {
      const o = visibleOptions(c, airline)[0];
      if (o && (!best || o.price < best[1])) best = [k, o.price];
    }
    return best;
  }, [cells, airline]);

  if (error) return <section className="card"><p className="warn">{error}</p><button className="btn ghost" onClick={onBack}>Back</button></section>;
  if (!data) return <p className="muted">Loading…</p>;

  const w = data.watch;
  const shownKey = selected ?? cheapest?.[0] ?? null;
  const shownCell = shownKey ? cells.get(shownKey) : undefined;
  const checkedAt = shownKey ? data.prices.find((p) => cellKey(p.out, p.back) === shownKey)?.checkedAt : undefined;

  return (
    <section className="results">
      <div className="results-bar">
        <div>
          <button className="link" onClick={onBack}>← Watches</button>
          <h2>{w.name}{!w.enabled && <span className="badge muted-badge">Paused</span>}</h2>
          <div className="muted small">
            {w.origin} → {w.destination} · {w.adults + w.children} traveller{w.adults + w.children > 1 ? 's' : ''} · budget {money(w.budget, w.currency)}
            {w.reserve ? ` (reserve ${money(w.reserve, w.currency)})` : ''} · {w.pricesChecked}/{w.comboCount} dates checked · last check {ago(w.lastCheckedAt)}
          </div>
        </div>
        <span className="buttons">
          <button className="btn ghost" onClick={() => void load()}>Refresh</button>
          <button className="btn ghost" onClick={() => onHistory(w)}>History</button>
          <button className="btn ghost" onClick={() => onEdit(w)}>Edit</button>
          <button className="btn ghost danger" onClick={() => onDelete(w)}>Delete</button>
        </span>
      </div>
      {notice && <p className="banner warn">{notice}</p>}
      {data.combos.length === 0 ? (
        <p className="banner warn">All dates of this watch are in the past. Edit the dates to keep watching.</p>
      ) : (
        <>
          <div className="results-bar">
            <span className="muted">{cheapest ? `Best ${money(cheapest[1], w.currency)}` : 'No prices yet. The first check runs within an hour.'}</span>
            <label className="field inline-field">
              <span className="label">Airline</span>
              <select value={airline} onChange={(e) => { setAirline(e.target.value); setSelected(null); }}>
                <option value="">All airlines</option>
                {[...names].map(([code, name]) => <option key={code} value={code}>{name}{name !== code ? ` (${code})` : ''}</option>)}
              </select>
            </label>
          </div>
          <PriceGrid combos={data.combos} cells={cells} airline={airline} currency={w.currency} selected={shownKey} onSelect={setSelected} missing="unchecked" />
          <div className="legend">
            <span className="cell best">Cheapest</span><span className="cell cheap">Cheap</span><span className="cell moderate">Moderate</span><span className="cell expensive">Expensive</span>
            <span className="muted">— no allowed flight · not checked yet</span>
          </div>
          {shownCell && (
            <>
              {checkedAt && <p className="muted small">Checked {ago(checkedAt)}.</p>}
              <FlightDetails options={visibleOptions(shownCell, airline)} currency={w.currency} />
            </>
          )}
        </>
      )}
      <details className="card">
        <summary>Recent checks</summary>
        {data.runs.length === 0 ? (
          <p className="muted small">No checks yet.</p>
        ) : (
          <ul className="runs">
            {data.runs.map((r, i) => (
              <li key={i} className={r.errors ? 'warn' : undefined}>
                <span className="muted">{ago(r.at)}</span> {r.message}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
