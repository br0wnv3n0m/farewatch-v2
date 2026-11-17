import type { CellOption, CellStatus, Combo, DateRange } from '../backend/types';
import { addDays } from './format';

export interface CellState {
  status: CellStatus;
  options: CellOption[];
  message?: string;
}

export type Tier = 'best' | 'cheap' | 'moderate' | 'expensive';

export const cellKey = (out: string, back: string | null) => `${out}|${back ?? ''}`;

/** Options that pass the airline filter ('' = all). One carrier = whole trip on it. */
export function visibleOptions(cell: CellState | undefined, airline: string): CellOption[] {
  if (!cell || cell.status !== 'ok') return [];
  const list = airline ? cell.options.filter((o) => o.airlines.length === 1 && o.airlines[0] === airline) : cell.options;
  return [...list].sort((a, b) => a.price - b.price);
}

/** Colour tier per cell: cheapest overall, then thirds by rank. */
export function tiers(prices: Map<string, number>): Map<string, Tier> {
  const sorted = [...prices.entries()].sort((a, b) => a[1] - b[1]);
  const result = new Map<string, Tier>();
  const min = sorted[0]?.[1];
  sorted.forEach(([key, price], i) => {
    if (price === min) result.set(key, 'best');
    else {
      const rank = i / Math.max(sorted.length - 1, 1);
      result.set(key, rank < 1 / 3 ? 'cheap' : rank < 2 / 3 ? 'moderate' : 'expensive');
    }
  });
  return result;
}

/** Row and column dates for the grid. One way: a single row of leave dates. */
export function axes(combos: Combo[]) {
  const outs = [...new Set(combos.map((c) => c.out))].sort();
  const backs = [...new Set(combos.map((c) => c.back).filter((b): b is string => b !== null))].sort();
  return { outs, backs, oneWay: backs.length === 0 };
}

/** Airline code -> display name, from every option seen so far. */
export function airlineNames(cells: Map<string, CellState>): Map<string, string> {
  const names = new Map<string, string>();
  for (const cell of cells.values())
    for (const o of cell.options)
      for (const leg of [o.out, o.back])
        for (const f of leg?.flights ?? []) {
          const code = f.flight_number.slice(0, 2);
          if (!names.has(code)) names.set(code, f.airline && f.airline !== code ? f.airline : code);
        }
  return new Map([...names.entries()].sort((a, b) => a[1].localeCompare(b[1])));
}

/** Every leave/return combo, same rule as the engine and server (return on or after leaving). */
export function buildCombos(outDates: DateRange, backDates: DateRange | null, today = ''): Combo[] {
  const days = (r: DateRange) => {
    const list: string[] = [];
    for (let d = r.from; d <= r.to && list.length < 62; d = addDays(d, 1)) list.push(d);
    return list;
  };
  const outs = days(outDates).filter((d) => d >= today);
  if (!backDates) return outs.map((out) => ({ out, back: null }));
  const backs = days(backDates);
  return outs.flatMap((out) => backs.filter((b) => b >= out).map((back) => ({ out, back })));
}
