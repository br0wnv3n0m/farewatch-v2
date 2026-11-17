import { useState } from 'react';
import type { LookupRequest } from '../backend/types';
import { addDays, todayIso } from '../lib/format';
import { countCombos, TripFields, tripProblem } from './TripFields';

const MAX_COMBOS = 49; // same limit as the engine

export function defaultRequest(blocked: string[], currency: string): LookupRequest {
  const t = todayIso();
  return {
    origin: 'YVR', destination: '', currency, adults: 1, children: 0, cabin: 1, maxStops: 1, maxLayover: 360,
    outDates: { from: addDays(t, 30), to: addDays(t, 32) },
    backDates: { from: addDays(t, 44), to: addDays(t, 46) },
    blockedCountries: blocked, airlines: [],
  };
}

interface Props {
  initial: LookupRequest;
  running: boolean;
  disabledReason?: string;
  onSearch: (r: LookupRequest) => void;
  onCancel: () => void;
}

export function LookupForm({ initial, running, disabledReason, onSearch, onCancel }: Props) {
  const [r, setR] = useState<LookupRequest>(initial);
  const set = (patch: Partial<LookupRequest>) => setR((prev) => ({ ...prev, ...patch }));

  const combos = countCombos(r);
  const minutesEta = Math.ceil((combos * (r.backDates ? 11 : 6)) / 60);
  const problem =
    disabledReason ?? tripProblem(r, todayIso()) ?? (combos > MAX_COMBOS ? `${combos} combinations; the limit is ${MAX_COMBOS}.` : undefined);

  return (
    <form
      className="lookup-form card"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && !running) onSearch(r);
      }}
    >
      <TripFields value={r} onChange={set} />
      <div className="row actions">
        <span className={problem ? 'hint warn' : 'hint'}>
          {problem ?? `${combos} date combination${combos === 1 ? '' : 's'} · about ${minutesEta} min`}
        </span>
        {running ? (
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        ) : (
          <button type="submit" className="btn primary" disabled={!!problem}>Search prices</button>
        )}
      </div>
    </form>
  );
}
