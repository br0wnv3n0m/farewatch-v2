// Remembers the last lookup form values on this device, so the form opens with them.
import type { LookupRequest } from '../backend/types';
import { addDays } from './format';

const KEY = 'farewatch.lookup.last.v1';

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isRange = (v: unknown): v is { from: string; to: string } =>
  !!v && typeof v === 'object' && isDate((v as { from: unknown }).from) && isDate((v as { to: unknown }).to);
const codes = (v: unknown, re: RegExp) => (Array.isArray(v) && v.every((c) => typeof c === 'string' && re.test(c)) ? (v as string[]) : undefined);
const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : undefined);

/** Saved values over the defaults. Bad or missing fields fall back to the default. */
export function loadLastLookup(defaults: LookupRequest, today: string): LookupRequest {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!s || typeof s !== 'object') return defaults;
  } catch {
    return defaults;
  }
  const r: LookupRequest = {
    ...defaults,
    origin: typeof s.origin === 'string' && /^[A-Z]{3}$/.test(s.origin) ? s.origin : defaults.origin,
    destination: typeof s.destination === 'string' && /^[A-Z]{0,3}$/.test(s.destination) ? s.destination : defaults.destination,
    currency: typeof s.currency === 'string' && /^[A-Z]{3}$/.test(s.currency) ? s.currency : defaults.currency,
    adults: int(s.adults, 1, 6) ?? defaults.adults,
    children: int(s.children, 0, 5) ?? defaults.children,
    cabin: (int(s.cabin, 1, 4) ?? defaults.cabin) as LookupRequest['cabin'],
    maxStops: (int(s.maxStops, 0, 2) ?? defaults.maxStops) as LookupRequest['maxStops'],
    maxLayover: int(s.maxLayover, 30, 1440) ?? defaults.maxLayover,
    blockedCountries: codes(s.blockedCountries, /^[A-Z]{2}$/) ?? defaults.blockedCountries,
    airlines: codes(s.airlines, /^[A-Z0-9]{2}$/) ?? defaults.airlines,
  };
  if (r.adults + r.children > 6) r.children = 6 - r.adults;
  if (isRange(s.outDates)) {
    r.outDates = s.outDates;
    r.backDates = s.backDates === null ? null : isRange(s.backDates) ? s.backDates : defaults.backDates;
    // Dates now in the past: move both ranges forward together (same lengths, same gap),
    // so the leaving range starts today.
    const late = days(r.outDates.from, today);
    if (late > 0) {
      const shift = (d: { from: string; to: string }) => ({ from: addDays(d.from, late), to: addDays(d.to, late) });
      r.outDates = shift(r.outDates);
      if (r.backDates) r.backDates = shift(r.backDates);
    }
  }
  return r;
}

export function saveLastLookup(r: LookupRequest): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable: nothing remembered */
  }
}
