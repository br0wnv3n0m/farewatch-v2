// Shared data shapes. These match the JSON lines from the Python engine
// (engine/farewatch_engine/lookup.py) and, later, the watch server API.

export type IsoDate = string; // "2026-12-20"

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

export interface LookupRequest {
  origin: string; // IATA, e.g. "YVR"
  destination: string;
  currency: string; // "CAD"
  adults: number; // 1-6
  children: number; // 0-5, adults + children <= 6
  cabin: 1 | 2 | 3 | 4; // economy, premium economy, business, first
  maxStops: 0 | 1 | 2;
  maxLayover: number; // minutes, 30-1440
  outDates: DateRange;
  backDates: DateRange | null; // null = one way
  blockedCountries: string[]; // ISO2, no layovers allowed there
  airlines: string[]; // IATA carrier codes; empty = any
  maxOutboundTries?: number; // 1-3
}

export interface Airport {
  id: string;
  time: string; // "2026-12-20 08:15" (local time at that airport)
}

export interface Flight {
  departure_airport: Airport;
  arrival_airport: Airport;
  flight_number: string;
  airline: string;
}

export interface Layover {
  id: string;
  duration: number; // minutes
  country?: string | null; // ISO2, added by the engine for display
}

export interface Leg {
  price: number;
  flights: Flight[];
  layovers: Layover[];
}

export interface CellOption {
  price: number; // full trip price for all travellers
  out: Leg;
  back: Leg | null;
  airlines: string[]; // every carrier used on the trip
}

export interface Combo {
  out: IsoDate;
  back: IsoDate | null;
}

export type CellStatus = 'pending' | 'ok' | 'none' | 'error';

export type LookupEvent =
  | { type: 'start'; total: number; combos: Combo[] }
  | { type: 'cell'; out: IsoDate; back: IsoDate | null; status: Exclude<CellStatus, 'pending'>; options: CellOption[]; message?: string }
  | { type: 'fatal'; message: string }
  | { type: 'done'; checked: number };

export interface LookupHandle {
  cancel(): Promise<void>;
}

export interface Settings {
  blockedCountries: string[];
  currency: string;
  alertEmail: string | null; // used for alerts (step 4); kept on the server only
}

export interface EngineInfo {
  version: string;
  airports: number;
}

// ---------- watch server (v2/server) ----------

/** Trip fields shared by a lookup and a watch. */
export type TripSearch = Omit<LookupRequest, 'maxOutboundTries'> & { maxOutboundTries?: number };

export interface WatchInput extends TripSearch {
  name: string;
  enabled: boolean;
  budget: number; // total trip price for all travellers
  reserve: number; // extra-cost reserve (bags, seats): "under budget" = price + reserve <= budget
  bags: number; // checked bags wanted; prices never include them
  allowUnverifiedBags: boolean; // alert even though bag costs are not checked
  pairsPerRun: number; // date combinations checked per hourly run (1-10)
}

export interface Watch extends WatchInput {
  id: number;
  revision: number;
  comboCount: number; // future date combinations
  pricesChecked: number;
  bestPrice: number | null;
  underBudget: boolean;
  lastCheckedAt: number | null; // ms
  checking: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WatchPrice {
  out: IsoDate;
  back: IsoDate | null;
  status: 'ok' | 'none';
  price: number | null;
  checkedAt: number;
  options: CellOption[];
}

export interface WatchRun {
  at: number;
  checked: number;
  found: number;
  errors: number;
  message: string;
}

export interface WatchDetail {
  watch: Watch;
  combos: Combo[];
  prices: WatchPrice[];
  runs: WatchRun[];
}

export interface SavedCell {
  out: IsoDate;
  back: IsoDate | null;
  status: 'ok' | 'none' | 'error';
  options: CellOption[];
  message?: string;
}

export interface SavedLookupSummary {
  id: string;
  createdAt: number;
  origin: string;
  destination: string;
  currency: string;
  outDates: DateRange;
  backDates: DateRange | null;
  total: number;
  checked: number;
  bestPrice: number | null;
  complete: boolean;
}

export interface SavedLookup {
  lookup: SavedLookupSummary;
  request: LookupRequest;
  combos: Combo[];
  cells: SavedCell[];
}

export interface RunnerStatus {
  lastPollAt: number | null;
  lastReportAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface EmailLogEntry {
  at: number;
  kind: 'fares' | 'stopped' | 'resumed' | 'repo' | 'test';
  ok: boolean;
  message: string;
}

/** Alert emails and the "checks have stopped" monitor (step 4). */
export interface AlertStatus {
  emailBlocker: string | null; // why email cannot be sent, or null when it can
  outageSince: number | null; // checks stopped since (null = fine)
  outageReason: string | null;
  repoCommitAt: number | null; // newest repo commit the runner saw (GitHub's 60-day pause)
  dispatchAt: number | null; // last time the server asked GitHub to start the workflow
  dispatchError: string | null; // why that failed, if it did
  recentEmails: EmailLogEntry[];
}

export interface ServerStatus {
  runner: RunnerStatus;
  alerts: AlertStatus;
}

/** GET /api/watches/:id/history (current search settings only). */
export interface WatchHistory {
  currency: string;
  budget: number;
  reserve: number;
  days: { day: IsoDate; low: number }[];
  combos: { out: IsoDate; back: IsoDate | null; low: number; high: number; checks: number; lastAt: number; latest: number | null }[];
  points: { at: number; price: number; airlines: string[] }[] | null;
}

export interface ServerConnection {
  url: string | null; // null = not set up
  signedIn: boolean;
}

/** Watch server calls. Same on PC and phone (see serverClient.ts). */
export interface ServerApi {
  connection(): ServerConnection;
  signIn(url: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  status(): Promise<ServerStatus>;
  sendTestEmail(): Promise<string>;
  getHistory(id: number, combo?: Combo): Promise<WatchHistory>;
  listWatches(): Promise<Watch[]>;
  getWatch(id: number): Promise<WatchDetail>;
  createWatch(w: WatchInput): Promise<number>;
  updateWatch(id: number, w: WatchInput): Promise<{ pricesCleared: boolean }>;
  setWatchEnabled(id: number, enabled: boolean): Promise<void>;
  deleteWatch(id: number): Promise<void>;
  saveLookup(request: LookupRequest, cells: SavedCell[], complete: boolean): Promise<string>;
  listLookups(): Promise<SavedLookupSummary[]>;
  getLookup(id: string): Promise<SavedLookup>;
  deleteLookup(id: string): Promise<void>;
}

/** Everything the UI may do. The UI never imports Tauri or fetch() directly. */
export interface Backend {
  kind: 'desktop' | 'web' | 'demo';
  /** Live lookup runs only where the scraper can run (the PC). */
  canLookup: boolean;
  engineInfo(): Promise<EngineInfo | null>;
  startLookup(req: LookupRequest, onEvent: (e: LookupEvent) => void): Promise<LookupHandle>;
  /** From the server when signed in (cached on this device), else from this device. */
  loadSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
  /** Open a web page outside the app (system browser). Only Google Flights links are used. */
  openLink(url: string): Promise<void>;
  server: ServerApi;
}
