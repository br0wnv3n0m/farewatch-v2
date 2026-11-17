// In-memory stand-in for the watch server, used in demo mode ("npm run dev").
// Data is lost on reload. Prices are fake.
import { buildCombos } from '../lib/grid';
import { todayIso } from '../lib/format';
import { fakeOptions } from './demoData';
import type { SavedLookup, ServerApi, Watch, WatchDetail, WatchInput } from './types';

let nextId = 1;
const watches = new Map<number, Watch>();
const lookups = new Map<string, SavedLookup>();

function detail(w: Watch): WatchDetail {
  const combos = buildCombos(w.outDates, w.backDates, todayIso());
  // Pretend the runner has checked the first half of the combos.
  const prices = combos.slice(0, Math.ceil(combos.length / 2)).map((c, i) => {
    const options = i % 7 === 3 ? [] : fakeOptions(w, c, w.id * 13 + i).slice(0, 5);
    return { out: c.out, back: c.back, status: options.length ? ('ok' as const) : ('none' as const), price: options[0]?.price ?? null, checkedAt: Date.now() - i * 3_600_000, options };
  });
  const best = prices.reduce<number | null>((m, p) => (p.price !== null && (m === null || p.price < m) ? p.price : m), null);
  const watch = { ...w, comboCount: combos.length, pricesChecked: prices.length, bestPrice: best, underBudget: best !== null && best + w.reserve <= w.budget, lastCheckedAt: Date.now() - 20 * 60_000 };
  return { watch, combos, prices, runs: [{ at: Date.now() - 20 * 60_000, checked: w.pairsPerRun, found: w.pairsPerRun - 1, errors: 0, message: `Checked ${w.pairsPerRun} of ${w.pairsPerRun} date combinations (demo).` }] };
}

function toWatch(id: number, w: WatchInput, prev?: Watch): Watch {
  return { ...w, id, revision: (prev?.revision ?? 0) + 1, comboCount: 0, pricesChecked: 0, bestPrice: null, underBudget: false, lastCheckedAt: null, checking: false, createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now() };
}

export const demoServer: ServerApi = {
  connection: () => ({ url: 'demo', signedIn: true }),
  async signIn() {},
  async signOut() {},
  async runnerStatus() {
    return { lastPollAt: Date.now() - 5 * 60_000, lastReportAt: Date.now() - 20 * 60_000, lastOkAt: Date.now() - 20 * 60_000, lastError: null };
  },
  async listWatches() {
    return [...watches.values()].map((w) => detail(w).watch);
  },
  async getWatch(id) {
    const w = watches.get(id);
    if (!w) throw new Error('Watch not found.');
    return detail(w);
  },
  async createWatch(input) {
    if (watches.size >= 10) throw new Error('You can keep up to 10 watches. Delete one first.');
    const id = nextId++;
    watches.set(id, toWatch(id, input));
    return id;
  },
  async updateWatch(id, input) {
    const prev = watches.get(id);
    if (!prev) throw new Error('Watch not found.');
    watches.set(id, toWatch(id, input, prev));
    return { pricesCleared: false };
  },
  async setWatchEnabled(id, enabled) {
    const w = watches.get(id);
    if (w) watches.set(id, { ...w, enabled });
  },
  async deleteWatch(id) {
    watches.delete(id);
  },
  async saveLookup(request, cells, complete) {
    const id = crypto.randomUUID();
    const best = cells.reduce<number | null>((m, c) => (c.options[0] && (m === null || c.options[0].price < m) ? c.options[0].price : m), null);
    const combos = buildCombos(request.outDates, request.backDates);
    lookups.set(id, {
      lookup: { id, createdAt: Date.now(), origin: request.origin, destination: request.destination, currency: request.currency, outDates: request.outDates, backDates: request.backDates, total: combos.length, checked: cells.length, bestPrice: best, complete },
      request,
      combos,
      cells,
    });
    return id;
  },
  async listLookups() {
    return [...lookups.values()].map((l) => l.lookup).sort((a, b) => b.createdAt - a.createdAt);
  },
  async getLookup(id) {
    const l = lookups.get(id);
    if (!l) throw new Error('Saved lookup not found.');
    return l;
  },
  async deleteLookup(id) {
    lookups.delete(id);
  },
};
