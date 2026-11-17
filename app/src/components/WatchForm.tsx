import { useState } from 'react';
import type { WatchInput } from '../backend/types';
import { addDays, money, todayIso } from '../lib/format';
import { NumberInput } from './NumberInput';
import { countCombos, TripFields, tripProblem } from './TripFields';

const MAX_COMBOS = 100; // same limit as the server
const MAX_WINDOW_DAYS = 61;

export function defaultWatch(blocked: string[], currency: string): WatchInput {
  const t = todayIso();
  return {
    name: '', enabled: true, origin: 'YVR', destination: '', currency, adults: 1, children: 0, cabin: 1, maxStops: 1, maxLayover: 360,
    outDates: { from: addDays(t, 30), to: addDays(t, 36) }, backDates: { from: addDays(t, 44), to: addDays(t, 50) },
    blockedCountries: blocked, airlines: [], budget: 1500, reserve: 0, bags: 0, allowUnverifiedBags: false, pairsPerRun: 5,
  };
}

const span = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

interface Props {
  initial: WatchInput;
  isNew: boolean;
  busy: boolean;
  onSave: (w: WatchInput) => void;
  onCancel: () => void;
}

export function WatchForm({ initial, isNew, busy, onSave, onCancel }: Props) {
  const [w, setW] = useState<WatchInput>(initial);
  const set = (patch: Partial<WatchInput>) => setW((prev) => ({ ...prev, ...patch }));

  const combos = countCombos(w);
  const cycleHours = Math.ceil(combos / w.pairsPerRun);
  const problem =
    tripProblem(w, todayIso()) ??
    (span(w.outDates.from, w.outDates.to) > MAX_WINDOW_DAYS || (w.backDates && span(w.backDates.from, w.backDates.to) > MAX_WINDOW_DAYS)
      ? `A date range can cover at most ${MAX_WINDOW_DAYS} days.`
      : combos > MAX_COMBOS ? `${combos} combinations; the limit is ${MAX_COMBOS}.`
      : !(w.budget > 0) ? 'Enter a total budget.'
      : w.reserve >= w.budget ? 'The extra-cost reserve must be below the budget.'
      : undefined);

  return (
    <form
      className="lookup-form card"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && !busy) onSave({ ...w, name: w.name.trim() || `${w.origin} → ${w.destination}` });
      }}
    >
      <h2>{isNew ? 'New watch' : 'Edit watch'}</h2>
      <div className="row">
        <label className="field grow">
          <span className="label">Name</span>
          <input value={w.name} maxLength={80} placeholder={w.destination ? `${w.origin} → ${w.destination}` : 'India trip'} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="inline enabled-toggle">
          <input type="checkbox" checked={w.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Checking on
        </label>
      </div>
      <TripFields value={w} onChange={set} />
      <div className="row">
        <label className="field small">
          <span className="label">Budget (total)</span>
          <NumberInput min={1} max={1000000} value={w.budget} onChange={(budget) => set({ budget })} />
        </label>
        <label className="field small">
          <span className="label">Extra-cost reserve</span>
          <NumberInput min={0} max={1000000} value={w.reserve} onChange={(reserve) => set({ reserve })} />
        </label>
        <label className="field small">
          <span className="label">Checked bags</span>
          <NumberInput integer min={0} max={4} value={w.bags} onChange={(bags) => set({ bags })} />
        </label>
        <label className="field small">
          <span className="label">Dates per check</span>
          <NumberInput integer min={1} max={10} value={w.pairsPerRun} onChange={(pairsPerRun) => set({ pairsPerRun })} />
        </label>
        {w.bags > 0 && (
          <label className="inline consent">
            <input type="checkbox" checked={w.allowUnverifiedBags} onChange={(e) => set({ allowUnverifiedBags: e.target.checked })} />
            Alert me even though bag fees are not checked (prices never include bags)
          </label>
        )}
      </div>
      <div className="row actions">
        <span className={problem ? 'hint warn' : 'hint'}>
          {problem ??
            `${combos} date combination${combos === 1 ? '' : 's'} · all checked about every ${cycleHours} h · under budget = price + ${money(w.reserve, w.currency)} ≤ ${money(w.budget, w.currency)}`}
        </span>
        <span className="buttons">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!!problem || busy}>{busy ? 'Saving…' : isNew ? 'Create watch' : 'Save changes'}</button>
        </span>
      </div>
    </form>
  );
}
