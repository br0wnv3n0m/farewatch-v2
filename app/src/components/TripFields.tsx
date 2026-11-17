import { useState } from 'react';
import type { DateRange, TripSearch } from '../backend/types';
import { addDays } from '../lib/format';
import { CountryPicker } from './CountryPicker';

/** Number of leave/return combos (return on or after leaving). */
export function countCombos(r: { outDates: DateRange; backDates: DateRange | null }): number {
  const span = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
  if (r.outDates.to < r.outDates.from) return 0;
  if (!r.backDates) return span(r.outDates.from, r.outDates.to);
  if (r.backDates.to < r.backDates.from) return 0;
  let n = 0;
  for (let o = r.outDates.from; o <= r.outDates.to; o = addDays(o, 1))
    for (let b = r.backDates.from; b <= r.backDates.to; b = addDays(b, 1)) if (b >= o) n++;
  return n;
}

/** Shared problems for a lookup or a watch, or undefined when it looks fine. */
export function tripProblem(r: TripSearch, today: string): string | undefined {
  if (!/^[A-Z]{3}$/.test(r.origin) || !/^[A-Z]{3}$/.test(r.destination)) return 'Enter both airport codes.';
  if (r.origin === r.destination) return 'From and To must differ.';
  if (r.outDates.from < today) return 'Leaving dates are in the past.';
  if (r.adults + r.children > 6) return 'At most 6 travellers.';
  if (countCombos(r) === 0) return 'No valid date combinations.';
  return undefined;
}

const code = (v: string) => v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);

interface Props<T extends TripSearch> {
  value: T;
  onChange: (patch: Partial<TripSearch>) => void;
}

/** Route, dates, travellers and layover rules. Used by the lookup form and the watch form. */
export function TripFields<T extends TripSearch>({ value: r, onChange: set }: Props<T>) {
  const [lastBack, setLastBack] = useState(r.backDates);
  return (
    <>
      <div className="row">
        <label className="field small">
          <span className="label">From</span>
          <input value={r.origin} onChange={(e) => set({ origin: code(e.target.value) })} placeholder="YVR" />
        </label>
        <button type="button" className="swap" title="Swap" onClick={() => set({ origin: r.destination, destination: r.origin })}>⇄</button>
        <label className="field small">
          <span className="label">To</span>
          <input value={r.destination} onChange={(e) => set({ destination: code(e.target.value) })} placeholder="DEL" />
        </label>
        <fieldset className="field">
          <span className="label">Leave between</span>
          <div className="pair">
            <input type="date" value={r.outDates.from} onChange={(e) => set({ outDates: { ...r.outDates, from: e.target.value } })} />
            <input type="date" value={r.outDates.to} onChange={(e) => set({ outDates: { ...r.outDates, to: e.target.value } })} />
          </div>
        </fieldset>
        <fieldset className="field">
          <span className="label">
            Return between
            <label className="inline">
              <input
                type="checkbox"
                checked={r.backDates === null}
                onChange={(e) => {
                  if (e.target.checked) { setLastBack(r.backDates); set({ backDates: null }); }
                  else set({ backDates: lastBack ?? { from: addDays(r.outDates.to, 7), to: addDays(r.outDates.to, 9) } });
                }}
              />
              one way
            </label>
          </span>
          {r.backDates ? (
            <div className="pair">
              <input type="date" value={r.backDates.from} onChange={(e) => set({ backDates: { ...r.backDates!, from: e.target.value } })} />
              <input type="date" value={r.backDates.to} onChange={(e) => set({ backDates: { ...r.backDates!, to: e.target.value } })} />
            </div>
          ) : (
            <div className="pair muted">No return flight</div>
          )}
        </fieldset>
      </div>
      <div className="row">
        <label className="field small">
          <span className="label">Adults</span>
          <input type="number" min={1} max={6} value={r.adults} onChange={(e) => set({ adults: Number(e.target.value) || 1 })} />
        </label>
        <label className="field small">
          <span className="label">Children</span>
          <input type="number" min={0} max={5} value={r.children} onChange={(e) => set({ children: Number(e.target.value) || 0 })} />
        </label>
        <label className="field">
          <span className="label">Cabin</span>
          <select value={r.cabin} onChange={(e) => set({ cabin: Number(e.target.value) as TripSearch['cabin'] })}>
            <option value={1}>Economy</option>
            <option value={2}>Premium economy</option>
            <option value={3}>Business</option>
            <option value={4}>First</option>
          </select>
        </label>
        <label className="field">
          <span className="label">Stops</span>
          <select value={r.maxStops} onChange={(e) => set({ maxStops: Number(e.target.value) as TripSearch['maxStops'] })}>
            <option value={0}>Non-stop only</option>
            <option value={1}>Up to 1</option>
            <option value={2}>Up to 2</option>
          </select>
        </label>
        <label className="field small">
          <span className="label">Max layover (h)</span>
          <input type="number" min={1} max={24} step={0.5} value={r.maxLayover / 60} onChange={(e) => set({ maxLayover: Math.min(1440, Math.max(30, Math.round(Number(e.target.value) * 60) || 30)) })} />
        </label>
        <label className="field small">
          <span className="label">Currency</span>
          <input value={r.currency} onChange={(e) => set({ currency: code(e.target.value) })} />
        </label>
        <CountryPicker value={r.blockedCountries} onChange={(blockedCountries) => set({ blockedCountries })} />
      </div>
    </>
  );
}
