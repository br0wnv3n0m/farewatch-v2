import { useEffect, useState } from 'react';
import type { SavedLookup, SavedLookupSummary, ServerApi } from '../backend/types';
import { ago, money, rangeText } from '../lib/format';

interface Props {
  server: ServerApi;
  /** Changes after a new lookup was saved, to reload the list. */
  refreshKey: number;
  onOpen: (saved: SavedLookup) => void;
}

/** Lookups saved on the server by the PC app. The phone shows results this way. */
export function SavedLookups({ server, refreshKey, onOpen }: Props) {
  const [list, setList] = useState<SavedLookupSummary[]>([]);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!server.connection().signedIn) return;
    server.listLookups().then(setList, (e: Error) => setError(e.message));
  }, [server, refreshKey]);

  if (!server.connection().signedIn || (!list.length && !error)) return null;

  const label = (l: SavedLookupSummary) =>
    `${l.origin} → ${l.destination} · ${rangeText(l.outDates)}${l.backDates ? ' / ' + rangeText(l.backDates) : ''} · ` +
    `${l.bestPrice === null ? 'no price' : money(l.bestPrice, l.currency)} · ${ago(l.createdAt)}${l.complete ? '' : ' · stopped early'}`;

  return (
    <div className="card saved-lookups">
      <label className="field grow">
        <span className="label">Saved lookups</span>
        <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
          <option value="">Choose a saved lookup…</option>
          {list.map((l) => <option key={l.id} value={l.id}>{label(l)}</option>)}
        </select>
      </label>
      <span className="buttons">
        <button
          className="btn ghost"
          disabled={!chosen}
          onClick={() => server.getLookup(chosen).then(onOpen, (e: Error) => setError(e.message))}
        >
          Open
        </button>
        <button
          className="btn ghost danger"
          disabled={!chosen}
          onClick={() =>
            server.deleteLookup(chosen).then(() => {
              setList((l) => l.filter((x) => x.id !== chosen));
              setChosen('');
            }, (e: Error) => setError(e.message))
          }
        >
          Delete
        </button>
      </span>
      {error && <p className="warn small">{error}</p>}
    </div>
  );
}
