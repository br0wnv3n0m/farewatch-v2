// Pure rules shared by every route: input validation, date combinations and
// the leg checks. The leg checks are a port of engine/farewatch_engine/filters.py
// so the server repeats exactly what the scraper already checked.
import airportsJson from '../../engine/farewatch_engine/data/airports.json' with { type: 'json' };

const AIRPORTS = airportsJson as Record<string, string>;
const DAY_MS = 86_400_000;

export const LIMITS = {
  maxWatches: 10,
  maxWindowDays: 61,
  maxWatchCombos: 100,
  maxLookupCombos: 49,
  maxOptionsPerCell: 10, // what the engine sends
  storedWatchOptions: 5, // kept per watch combo (enough for the airline filter)
  savedLookups: 30,
  maxPairsPerRun: 10,
} as const;

/** Bad input from the caller. Routes turn it into HTTP 400. */
export class InputError extends Error {}

// ---------- shapes (same as app/src/backend/types.ts) ----------

export interface DateRange { from: string; to: string }
export interface Combo { out: string; back: string | null }

export interface Airport { id: string; time: string }
export interface Flight { departure_airport: Airport; arrival_airport: Airport; flight_number: string; airline: string }
export interface Layover { id: string; duration: number; country?: string | null }
export interface Leg { price: number; flights: Flight[]; layovers: Layover[] }
export interface CellOption { price: number; out: Leg; back: Leg | null; airlines: string[] }

/** Everything the scraper needs. The runner never sees names, budgets or emails. */
export interface SearchRules {
  origin: string;
  destination: string;
  currency: string;
  adults: number;
  children: number;
  cabin: number;
  maxStops: number;
  maxLayover: number;
  maxOutboundTries: number;
  blockedCountries: string[];
  airlines: string[];
}

export interface WatchInput extends SearchRules {
  name: string;
  enabled: boolean;
  outDates: DateRange;
  backDates: DateRange | null;
  budget: number; // total trip price for all travellers
  reserve: number; // extra-cost reserve (bags, seats); alert when price + reserve <= budget
  bags: number; // checked bags wanted (prices never include them; they are unverified)
  allowUnverifiedBags: boolean; // consent: alert even though bag costs are unknown
  pairsPerRun: number; // date combos checked per hourly run
}

export interface SettingsInput {
  blockedCountries: string[];
  currency: string;
  alertEmail: string | null;
}

// ---------- small validators ----------

type Obj = Record<string, unknown>;

export function asObject(raw: unknown, what = 'Request'): Obj {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError(`${what} must be a JSON object.`);
  return raw as Obj;
}

function int(o: Obj, key: string, lo: number, hi: number, fallback?: number): number {
  const v = o[key] ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new InputError(`${key} must be a whole number from ${lo} to ${hi}.`);
  return v;
}

function num(o: Obj, key: string, lo: number, hi: number, fallback?: number): number {
  const v = o[key] ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new InputError(`${key} must be a number from ${lo} to ${hi}.`);
  return v;
}

function bool(o: Obj, key: string, fallback: boolean): boolean {
  const v = o[key] ?? fallback;
  if (typeof v !== 'boolean') throw new InputError(`${key} must be true or false.`);
  return v;
}

export function isoDate(value: unknown, key: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InputError(`${key} must be a date like 2026-12-20.`);
  const d = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new InputError(`${key} is not a real date.`);
  return value;
}

function window(o: Obj, key: string): DateRange {
  const w = asObject(o[key], key);
  const from = isoDate(w.from, key + '.from');
  const to = isoDate(w.to, key + '.to');
  if (to < from) throw new InputError(`${key}: "to" is before "from".`);
  if (daysBetween(from, to) + 1 > LIMITS.maxWindowDays) throw new InputError(`${key} can cover at most ${LIMITS.maxWindowDays} days.`);
  return { from, to };
}

export function code(o: Obj, key: string, fallback?: string): string {
  const v = String(o[key] ?? fallback ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(v)) throw new InputError(`${key} must be a 3-letter code.`);
  return v;
}

function codes(o: Obj, key: string, pattern: RegExp, limit: number): string[] {
  const v = o[key] ?? [];
  if (!Array.isArray(v) || v.length > limit) throw new InputError(`${key} must be a list of at most ${limit} codes.`);
  const out = new Set<string>();
  for (const item of v) {
    const c = typeof item === 'string' ? item.trim().toUpperCase() : '';
    if (!pattern.test(c)) throw new InputError(`${key} has an invalid code.`);
    out.add(c);
  }
  return [...out].sort();
}

export const blockedList = (o: Obj) => codes(o, 'blockedCountries', /^[A-Z]{2}$/, 60);
const airlineList = (o: Obj) => codes(o, 'airlines', /^[A-Z0-9]{2}$/, 20);

// ---------- dates ----------

export const todayUtc = (now: number) => new Date(now).toISOString().slice(0, 10);

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

function days(r: DateRange): string[] {
  const n = daysBetween(r.from, r.to) + 1;
  return Array.from({ length: Math.max(n, 0) }, (_, i) => addDays(r.from, i));
}

/** Future leave/return combos, in a fixed order (same rule as the engine: return >= leave). */
export function combos(outDates: DateRange, backDates: DateRange | null, today: string): Combo[] {
  const outs = days(outDates).filter((d) => d >= today);
  if (!backDates) return outs.map((out) => ({ out, back: null }));
  const backs = days(backDates);
  return outs.flatMap((out) => backs.filter((b) => b >= out).map((back) => ({ out, back })));
}

// ---------- watch, settings and lookup input ----------

export function searchRules(o: Obj): SearchRules {
  const origin = code(o, 'origin');
  const destination = code(o, 'destination');
  if (origin === destination) throw new InputError('origin and destination must differ.');
  const adults = int(o, 'adults', 1, 6, 1);
  const children = int(o, 'children', 0, 5, 0);
  if (adults + children > 6) throw new InputError('At most 6 travellers.');
  return {
    origin,
    destination,
    currency: code(o, 'currency', 'CAD'),
    adults,
    children,
    cabin: int(o, 'cabin', 1, 4, 1),
    maxStops: int(o, 'maxStops', 0, 2, 1),
    maxLayover: int(o, 'maxLayover', 30, 1440, 360),
    maxOutboundTries: int(o, 'maxOutboundTries', 1, 3, 2),
    blockedCountries: blockedList(o),
    airlines: airlineList(o),
  };
}

export function validateWatch(raw: unknown, now: number): WatchInput {
  const o = asObject(raw, 'Watch');
  const rules = searchRules(o);
  const name = String(o.name ?? '').trim().slice(0, 80) || `${rules.origin} → ${rules.destination}`;
  const outDates = window(o, 'outDates');
  const backDates = o.backDates === null || o.backDates === undefined ? null : window(o, 'backDates');
  const budget = num(o, 'budget', 1, 1_000_000);
  const reserve = num(o, 'reserve', 0, 1_000_000, 0);
  if (reserve >= budget) throw new InputError('Extra-cost reserve must be below the total budget.');
  const watch: WatchInput = {
    ...rules,
    name,
    enabled: bool(o, 'enabled', true),
    outDates,
    backDates,
    budget,
    reserve,
    bags: int(o, 'bags', 0, 4, 0),
    allowUnverifiedBags: bool(o, 'allowUnverifiedBags', false),
    pairsPerRun: int(o, 'pairsPerRun', 1, LIMITS.maxPairsPerRun, 5),
  };
  const n = combos(outDates, backDates, todayUtc(now)).length;
  if (n === 0) throw new InputError('No future date combinations. Pick future leave dates and a return on or after leaving.');
  if (n > LIMITS.maxWatchCombos) throw new InputError(`${n} date combinations; the limit is ${LIMITS.maxWatchCombos}. Narrow a date range.`);
  return watch;
}

export function validateSettings(raw: unknown): SettingsInput {
  const o = asObject(raw, 'Settings');
  let alertEmail: string | null = null;
  if (o.alertEmail !== null && o.alertEmail !== undefined && o.alertEmail !== '') {
    const e = String(o.alertEmail).trim();
    if (e.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)) throw new InputError('alertEmail is not a valid email address.');
    alertEmail = e;
  }
  return { blockedCountries: blockedList(o), currency: code(o, 'currency', 'CAD'), alertEmail };
}

// ---------- itineraries from the scraper ----------

const AIRPORT_ID = /^[A-Z0-9]{3}$/;
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function text(v: unknown, max: number, key: string): string {
  if (typeof v !== 'string' || v.length > max) throw new InputError(`Bad flight data: ${key}.`);
  return v;
}

function airport(v: unknown, key: string): Airport {
  const a = asObject(v, key);
  const id = text(a.id, 3, key + '.id').toUpperCase();
  const time = text(a.time, 16, key + '.time');
  if (!AIRPORT_ID.test(id) || !STAMP.test(time)) throw new InputError(`Bad flight data: ${key}.`);
  return { id, time };
}

/** Copy only known fields with checked types. Anything else is dropped. */
export function sanitizeLeg(raw: unknown): Leg {
  const o = asObject(raw, 'leg');
  if (!Array.isArray(o.flights) || o.flights.length < 1 || o.flights.length > 4) throw new InputError('Bad flight data: flights.');
  if (!Array.isArray(o.layovers) || o.layovers.length > 3) throw new InputError('Bad flight data: layovers.');
  const flights = o.flights.map((f, i) => {
    const x = asObject(f, `flight ${i}`);
    const number = text(x.flight_number, 12, 'flight_number').toUpperCase();
    if (!/^[A-Z0-9]{2}/.test(number)) throw new InputError('Bad flight data: flight_number.');
    return {
      departure_airport: airport(x.departure_airport, 'departure_airport'),
      arrival_airport: airport(x.arrival_airport, 'arrival_airport'),
      flight_number: number,
      airline: text(x.airline ?? '', 80, 'airline'),
    };
  });
  const layovers = o.layovers.map((l, i) => {
    const x = asObject(l, `layover ${i}`);
    const id = text(x.id, 3, 'layover.id').toUpperCase();
    if (!AIRPORT_ID.test(id) || typeof x.duration !== 'number' || !Number.isFinite(x.duration)) throw new InputError('Bad flight data: layover.');
    return { id, duration: x.duration, country: countryOf(id) };
  });
  const price = typeof o.price === 'number' && Number.isFinite(o.price) ? o.price : 0;
  return { price, flights, layovers };
}

export function sanitizeOption(raw: unknown, roundTrip: boolean): CellOption {
  const o = asObject(raw, 'option');
  if (typeof o.price !== 'number' || !Number.isFinite(o.price) || o.price <= 0 || o.price > 10_000_000) throw new InputError('Bad flight data: price.');
  const out = sanitizeLeg(o.out);
  const back = roundTrip ? sanitizeLeg(o.back) : null;
  return { price: o.price, out, back, airlines: carriers(out, back) };
}

// ---------- leg checks (port of filters.py) ----------

export function countryOf(iata: string): string | null {
  return AIRPORTS[iata.trim().toUpperCase()] ?? null;
}

export const carrierOf = (f: Flight) => f.flight_number.slice(0, 2);

function carriers(...legs: (Leg | null)[]): string[] {
  return [...new Set(legs.flatMap((l) => (l ? l.flights.map(carrierOf) : [])))].sort();
}

/** Reason text if any layover is in a blocked country. Fail closed on unknown airports. */
export function blockedStop(leg: Leg, blocked: string[]): string | null {
  if (!blocked.length) return null;
  for (const f of leg.flights.slice(0, -1)) {
    const code = f.arrival_airport.id;
    const country = countryOf(code);
    if (country === null) return `unknown layover airport ${code}`;
    if (blocked.includes(country)) return `layover in blocked country ${country} (${code})`;
  }
  return null;
}

/** True if one direction of a trip passes every v2 rule. */
export function acceptableLeg(leg: Leg, rules: SearchRules, origin: string, destination: string, date: string): boolean {
  const f = leg.flights;
  if (!f.length || f.length - 1 > rules.maxStops) return false;
  if (f[0].departure_airport.id !== origin || f[f.length - 1].arrival_airport.id !== destination) return false;
  if (!f[0].departure_airport.time.startsWith(date)) return false;
  if (leg.layovers.length !== f.length - 1) return false;
  for (let i = 0; i < leg.layovers.length; i++) {
    const m = leg.layovers[i].duration;
    if (m < 0 || m >= rules.maxLayover) return false;
    if (f[i].arrival_airport.id !== f[i + 1].departure_airport.id) return false;
  }
  if (rules.airlines.length && f.some((x) => !rules.airlines.includes(carrierOf(x)))) return false;
  return blockedStop(leg, rules.blockedCountries) === null;
}

export function optionAllowed(o: CellOption, rules: SearchRules, combo: Combo): boolean {
  if (!acceptableLeg(o.out, rules, rules.origin, rules.destination, combo.out)) return false;
  if (combo.back === null) return o.back === null;
  return o.back !== null && acceptableLeg(o.back, rules, rules.destination, rules.origin, combo.back);
}
