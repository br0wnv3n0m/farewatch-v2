import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Backend, Combo, EngineInfo, LookupEvent, LookupHandle, LookupRequest, SavedCell, SavedLookup, Settings, WatchInput } from './backend/types';
import { FlightDetails } from './components/FlightDetails';
import { defaultRequest, LookupForm } from './components/LookupForm';
import { PriceGrid } from './components/PriceGrid';
import { SavedLookups } from './components/SavedLookups';
import { SettingsPanel } from './components/SettingsPanel';
import { WatchesPanel } from './components/WatchesPanel';
import { ago, money, shortDate } from './lib/format';
import { airlineNames, cellKey, visibleOptions, type CellState } from './lib/grid';

type Tab = 'lookup' | 'watches' | 'settings';
type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('farewatch.theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* ignore */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Round a price up to a tidy budget (next 50). */
const budgetFrom = (price: number) => Math.ceil(price / 50) * 50;

export default function App({ backend, initialSettings }: { backend: Backend; initialSettings: Settings }) {
  // Phone (web): open on Watches, or on Settings until signed in. Live lookup only runs on the PC.
  const [tab, setTab] = useState<Tab>(() =>
    backend.kind === 'web' ? (backend.server.connection().signedIn ? 'watches' : 'settings') : 'lookup',
  );
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [settings, setSettings] = useState(initialSettings);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineInfo | null | undefined>(undefined);
  const [serverTick, setServerTick] = useState(0); // bumps on sign in / out

  const [request, setRequest] = useState<LookupRequest | null>(null);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [cells, setCells] = useState<Map<string, CellState>>(new Map());
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const [airline, setAirline] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<WatchInput | null>(null);
  const handle = useRef<LookupHandle | null>(null);
  const pendingSave = useRef(false); // a live lookup is running and should be saved when it ends
  const completed = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  // Phone home-screen apps stay open in the background for days: reload server data
  // when the app comes back after 5+ minutes (same as signing in again).
  useEffect(() => {
    if (backend.kind !== 'web') return;
    let hiddenAt = 0;
    const onVisible = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 5 * 60_000) setServerTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [backend.kind]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b1324' : '#ffffff');
    try { localStorage.setItem('farewatch.theme', theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => { void backend.engineInfo().then(setEngine); }, [backend]);

  // Settings: update the screen at once; save (device + server) after typing pauses.
  const updateSettings = (s: Settings) => {
    setSettings(s);
    window.clearTimeout(saveTimer.current);
    if (!/^[A-Z]{3}$/.test(s.currency)) return;
    saveTimer.current = window.setTimeout(() => {
      backend.saveSettings(s).then(() => setSettingsError(null), (e: Error) => setSettingsError(`Saved on this device only: ${e.message}`));
    }, 700);
  };

  const onServerChange = () => {
    setServerTick((n) => n + 1);
    void backend.loadSettings().then(setSettings);
  };

  const onEvent = useCallback((e: LookupEvent) => {
    if (e.type === 'start') {
      setCombos(e.combos);
      setCells(new Map(e.combos.map((c) => [cellKey(c.out, c.back), { status: 'pending', options: [] } as CellState])));
    } else if (e.type === 'cell') {
      const key = cellKey(e.out, e.back);
      setCells((prev) => new Map(prev).set(key, { status: e.status, options: e.options, message: e.message }));
    } else if (e.type === 'fatal') {
      setRunning(false);
      setNotice(e.message);
      setCells((prev) => {
        const next = new Map(prev);
        for (const [k, c] of next) if (c.status === 'pending') next.delete(k);
        return next;
      });
    } else if (e.type === 'done') {
      completed.current = true;
      setRunning(false);
    }
  }, []);

  // When a live lookup ends, save it to the server so the phone can see it.
  useEffect(() => {
    if (running || !pendingSave.current || !request) return;
    pendingSave.current = false;
    if (!backend.server.connection().signedIn) return;
    const finished: SavedCell[] = combos.flatMap((c) => {
      const cell = cells.get(cellKey(c.out, c.back));
      return cell && cell.status !== 'pending' ? [{ out: c.out, back: c.back, status: cell.status, options: cell.options, message: cell.message }] : [];
    });
    if (!finished.length) return;
    backend.server.saveLookup(request, finished, completed.current).then(
      () => { setSaveNote('Saved to the server.'); setSavedTick((n) => n + 1); },
      (err: Error) => setSaveNote(`Not saved to the server: ${err.message}`),
    );
  }, [running, cells, combos, request, backend]);

  const resetResults = (r: LookupRequest | null) => {
    setRequest(r);
    setNotice(null);
    setSaveNote(null);
    setSelected(null);
    setAirline('');
    setCombos([]);
    setCells(new Map());
  };

  const search = async (r: LookupRequest) => {
    resetResults(r);
    completed.current = false;
    pendingSave.current = true;
    setRunning(true);
    try {
      handle.current = await backend.startLookup(r, onEvent);
    } catch (err) {
      pendingSave.current = false;
      setRunning(false);
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const openSaved = (s: SavedLookup) => {
    resetResults(s.request);
    setCombos(s.combos);
    setCells(new Map(s.cells.map((c) => [cellKey(c.out, c.back), { status: c.status, options: c.options, message: c.message }])));
    setNotice(`Saved lookup from ${ago(s.lookup.createdAt)}${s.lookup.complete ? '' : ' (stopped early)'}. Prices may have changed since.`);
  };

  const done = [...cells.values()].filter((c) => c.status !== 'pending').length;
  const names = useMemo(() => airlineNames(cells), [cells]);

  // Auto-select the cheapest cell so details show without a click.
  const cheapestKey = useMemo(() => {
    let best: [string, number] | null = null;
    for (const [k, c] of cells) {
      const o = visibleOptions(c, airline)[0];
      if (o && (!best || o.price < best[1])) best = [k, o.price];
    }
    return best;
  }, [cells, airline]);
  const shownKey = selected ?? cheapestKey?.[0] ?? null;
  const shownCell = shownKey ? cells.get(shownKey) : undefined;
  const currency = request?.currency ?? settings.currency;

  /** Start a watch from the lookup: one cell's dates, or the whole lookup range. */
  const watchFrom = (scope: 'cell' | 'all') => {
    if (!request) return;
    const [out, back] = (shownKey ?? '|').split('|');
    const cellPrice = shownCell ? visibleOptions(shownCell, airline)[0]?.price : undefined;
    const price = scope === 'cell' ? cellPrice : cheapestKey?.[1];
    const dates =
      scope === 'cell'
        ? { outDates: { from: out, to: out }, backDates: back ? { from: back, to: back } : null }
        : { outDates: request.outDates, backDates: request.backDates };
    setDraft({
      ...request,
      ...dates,
      airlines: airline ? [airline] : [],
      name: `${request.origin} → ${request.destination}${scope === 'cell' ? ` ${shortDate(out)}` : ''}`,
      enabled: true,
      budget: price ? budgetFrom(price) : 1500,
      reserve: 0,
      bags: 0,
      allowUnverifiedBags: false,
      pairsPerRun: 5,
    });
    setTab('watches');
  };
  const onDraftUsed = useCallback(() => setDraft(null), []);
  const signedIn = backend.server.connection().signedIn;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden>✈</span> Farewatch</div>
        <nav>
          <button className={tab === 'lookup' ? 'active' : ''} onClick={() => setTab('lookup')}>Lookup</button>
          <button className={tab === 'watches' ? 'active' : ''} onClick={() => setTab('watches')}>Watches</button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
        </nav>
        <button className="theme-switch" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Switch light or dark mode">
          {theme === 'dark' ? '☀ Light' : '☾ Dark'}
        </button>
      </header>

      <main>
        {tab === 'lookup' && (
          <>
            {!backend.canLookup && <SavedLookups key={serverTick} server={backend.server} refreshKey={savedTick} onOpen={openSaved} />}
            <LookupForm
              key={request ? JSON.stringify(request) : 'new'}
              initial={request ?? defaultRequest(settings.blockedCountries, settings.currency)}
              running={running}
              disabledReason={backend.canLookup ? undefined : 'Live lookup runs in the PC app. Open a saved lookup below.'}
              onSearch={search}
              onCancel={() => void handle.current?.cancel()}
            />
            {backend.canLookup && <SavedLookups key={serverTick} server={backend.server} refreshKey={savedTick} onOpen={openSaved} />}
            {backend.kind === 'demo' && <p className="banner">Demo mode: fake prices. Run the desktop app for real searches.</p>}
            {notice && <p className="banner warn">{notice}</p>}
            {combos.length > 0 && (
              <section className="results">
                <div className="results-bar">
                  <div>
                    <strong>{request?.origin} → {request?.destination}</strong>{' '}
                    <span className="muted">{done}/{combos.length} checked{cheapestKey ? ` · best ${money(cheapestKey[1], currency)}` : ''}</span>
                    {saveNote && <span className="muted small"> · {saveNote}</span>}
                  </div>
                  <label className="field inline-field">
                    <span className="label">Airline</span>
                    <select value={airline} onChange={(e) => { setAirline(e.target.value); setSelected(null); }}>
                      <option value="">All airlines</option>
                      {[...names].map(([code, name]) => <option key={code} value={code}>{name}{name !== code ? ` (${code})` : ''}</option>)}
                    </select>
                  </label>
                </div>
                {running && <div className="progress"><div style={{ width: `${(done / combos.length) * 100}%` }} /></div>}
                <PriceGrid combos={combos} cells={cells} airline={airline} currency={currency} selected={shownKey} onSelect={setSelected} />
                <div className="legend">
                  <span className="cell best">Cheapest</span><span className="cell cheap">Cheap</span><span className="cell moderate">Moderate</span><span className="cell expensive">Expensive</span>
                  <span className="muted">— no allowed flight · ! search failed</span>
                </div>
                {!running && signedIn && (
                  <div className="buttons">
                    <button className="btn ghost" disabled={!shownCell || shownCell.status !== 'ok'} onClick={() => watchFrom('cell')}>
                      Watch this fare{shownKey ? ` (${shownKey.split('|').filter(Boolean).map(shortDate).join(' – ')})` : ''}
                    </button>
                    <button className="btn ghost" onClick={() => watchFrom('all')}>Watch all these dates</button>
                  </div>
                )}
                {shownCell && shownCell.status !== 'pending' && (
                  <FlightDetails options={visibleOptions(shownCell, airline)} currency={currency} message={shownCell.status === 'error' ? shownCell.message : undefined} />
                )}
              </section>
            )}
          </>
        )}
        {tab === 'watches' && (
          <WatchesPanel
            key={serverTick}
            server={backend.server}
            settings={settings}
            draft={draft}
            onDraftUsed={onDraftUsed}
            onOpenSettings={() => setTab('settings')}
          />
        )}
        {tab === 'settings' && (
          <SettingsPanel
            key={serverTick}
            settings={settings}
            onChange={updateSettings}
            engine={engine}
            backendKind={backend.kind}
            server={backend.server}
            onServerChange={onServerChange}
            saveError={settingsError}
          />
        )}
      </main>
    </div>
  );
}
