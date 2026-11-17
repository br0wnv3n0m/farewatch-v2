// Watch management for the app: list, read, create, edit, pause, delete.
import { type Ctx, HttpError, idParam, json, readJson } from './http.ts';
import { asObject, type CellOption, combos, InputError, LIMITS, todayUtc, validateWatch, type WatchInput } from './rules.ts';

export interface WatchRow {
  id: number;
  name: string;
  enabled: number;
  origin: string;
  destination: string;
  currency: string;
  adults: number;
  children: number;
  cabin: number;
  max_stops: number;
  max_layover: number;
  max_outbound_tries: number;
  out_from: string;
  out_to: string;
  back_from: string | null;
  back_to: string | null;
  budget: number;
  reserve: number;
  bags: number;
  allow_unverified_bags: number;
  pairs_per_run: number;
  revision: number;
  cursor: number;
  last_checked_at: number;
  lease_run_id: string | null;
  lease_until: number;
  created_at: number;
  updated_at: number;
}

export function rowToInput(row: WatchRow, blocked: string[], airlines: string[]): WatchInput {
  return {
    name: row.name,
    enabled: row.enabled === 1,
    origin: row.origin,
    destination: row.destination,
    currency: row.currency,
    adults: row.adults,
    children: row.children,
    cabin: row.cabin,
    maxStops: row.max_stops,
    maxLayover: row.max_layover,
    maxOutboundTries: row.max_outbound_tries,
    outDates: { from: row.out_from, to: row.out_to },
    backDates: row.back_from && row.back_to ? { from: row.back_from, to: row.back_to } : null,
    blockedCountries: blocked,
    airlines,
    budget: row.budget,
    reserve: row.reserve,
    bags: row.bags,
    allowUnverifiedBags: row.allow_unverified_bags === 1,
    pairsPerRun: row.pairs_per_run,
  };
}

/** Watch rows plus their country and airline lists. */
export async function loadWatches(db: D1Database, id?: number): Promise<{ row: WatchRow; input: WatchInput }[]> {
  const where = id === undefined ? '' : ' WHERE id = ?';
  const childWhere = id === undefined ? '' : ' WHERE watch_id = ?';
  const bind = (s: D1PreparedStatement) => (id === undefined ? s : s.bind(id));
  const [rows, blocked, airlines] = await ctxBatch(db, [
    bind(db.prepare('SELECT * FROM watches' + where + ' ORDER BY id')),
    bind(db.prepare('SELECT watch_id, country FROM watch_blocked_countries' + childWhere + ' ORDER BY country')),
    bind(db.prepare('SELECT watch_id, airline FROM watch_airlines' + childWhere + ' ORDER BY airline')),
  ]);
  const group = (list: Record<string, unknown>[], key: string) => {
    const m = new Map<number, string[]>();
    for (const r of list) m.set(r.watch_id as number, [...(m.get(r.watch_id as number) ?? []), r[key] as string]);
    return m;
  };
  const b = group(blocked, 'country');
  const a = group(airlines, 'airline');
  return (rows as unknown as WatchRow[]).map((row) => ({ row, input: rowToInput(row, b.get(row.id) ?? [], a.get(row.id) ?? []) }));
}

async function ctxBatch(db: D1Database, statements: D1PreparedStatement[]) {
  const results = await db.batch<Record<string, unknown>>(statements);
  return results.map((r) => r.results ?? []);
}

interface PriceStats { best: number | null; n: number }

function view(row: WatchRow, input: WatchInput, stats: PriceStats | undefined, now: number) {
  const best = stats?.best ?? null;
  return {
    id: row.id,
    ...input,
    revision: row.revision,
    comboCount: combos(input.outDates, input.backDates, todayUtc(now)).length,
    pricesChecked: stats?.n ?? 0,
    bestPrice: best,
    underBudget: best !== null && best + input.reserve <= input.budget,
    lastCheckedAt: row.last_checked_at || null,
    checking: row.lease_until > now,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function stats(db: D1Database, today: string, id?: number): Promise<Map<number, PriceStats>> {
  const sql =
    'SELECT p.watch_id AS id, MIN(CASE WHEN p.status = \'ok\' THEN p.price END) AS best, COUNT(*) AS n ' +
    'FROM watch_prices p JOIN watches w ON w.id = p.watch_id AND w.revision = p.revision ' +
    'WHERE p.out_date >= ?' + (id === undefined ? '' : ' AND p.watch_id = ?') + ' GROUP BY p.watch_id';
  const s = db.prepare(sql);
  const res = await (id === undefined ? s.bind(today) : s.bind(today, id)).all<{ id: number; best: number | null; n: number }>();
  return new Map(res.results.map((r) => [r.id, { best: r.best, n: r.n }]));
}

// ---------- routes ----------

/** GET /api/watches */
export async function listWatches(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const all = await loadWatches(db);
  const s = await stats(db, todayUtc(ctx.now));
  return json({ watches: all.map(({ row, input }) => view(row, input, s.get(row.id), ctx.now)) });
}

/** GET /api/watches/:id -> watch, latest price per combo, recent runs */
export async function getWatch(ctx: Ctx, idText: string): Promise<Response> {
  const db = ctx.env.DB;
  const id = idParam(idText);
  const [found] = await loadWatches(db, id);
  if (!found) throw new HttpError(404, 'Watch not found.');
  const today = todayUtc(ctx.now);
  const s = await stats(db, today, id);
  const prices = await db
    .prepare('SELECT out_date, back_date, status, price, options_json, checked_at FROM watch_prices WHERE watch_id = ? AND revision = ? AND out_date >= ? ORDER BY out_date, back_date')
    .bind(id, found.row.revision, today)
    .all<{ out_date: string; back_date: string; status: string; price: number | null; options_json: string; checked_at: number }>();
  const runs = await db.prepare('SELECT at, checked, found, errors, message FROM watch_runs WHERE watch_id = ? ORDER BY id DESC LIMIT 20').bind(id).all();
  return json({
    watch: view(found.row, found.input, s.get(id), ctx.now),
    combos: combos(found.input.outDates, found.input.backDates, today),
    prices: prices.results.map((p) => ({
      out: p.out_date,
      back: p.back_date || null,
      status: p.status,
      price: p.price,
      checkedAt: p.checked_at,
      options: JSON.parse(p.options_json) as CellOption[],
    })),
    runs: runs.results,
  });
}

function childInserts(db: D1Database, idSql: string, idArgs: unknown[], w: WatchInput): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO watch_blocked_countries (watch_id, country) SELECT ${idSql}, value FROM json_each(?)`).bind(...idArgs, JSON.stringify(w.blockedCountries)),
    db.prepare(`INSERT INTO watch_airlines (watch_id, airline) SELECT ${idSql}, value FROM json_each(?)`).bind(...idArgs, JSON.stringify(w.airlines)),
  ];
}

/** POST /api/watches */
export async function createWatch(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const w = validateWatch(await readJson(ctx.request, 16_384), ctx.now);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM watches').first<{ n: number }>();
  if ((count?.n ?? 0) >= LIMITS.maxWatches) throw new HttpError(409, `You can keep up to ${LIMITS.maxWatches} watches. Delete one first.`);
  const created = await db
    .prepare(
      `INSERT INTO watches (name, enabled, origin, destination, currency, adults, children, cabin, max_stops, max_layover,
        max_outbound_tries, out_from, out_to, back_from, back_to, budget, reserve, bags, allow_unverified_bags, pairs_per_run,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(w.name, w.enabled ? 1 : 0, w.origin, w.destination, w.currency, w.adults, w.children, w.cabin, w.maxStops, w.maxLayover,
      w.maxOutboundTries, w.outDates.from, w.outDates.to, w.backDates?.from ?? null, w.backDates?.to ?? null, w.budget, w.reserve,
      w.bags, w.allowUnverifiedBags ? 1 : 0, w.pairsPerRun, ctx.now, ctx.now)
    .first<{ id: number }>();
  if (!created) throw new Error('insert returned no id');
  try {
    await db.batch(childInserts(db, '?', [created.id], w));
  } catch (err) {
    await db.prepare('DELETE FROM watches WHERE id = ?').bind(created.id).run();
    throw err;
  }
  return json({ id: created.id }, 201);
}

const SEARCH_KEYS: (keyof WatchInput)[] = [
  'origin', 'destination', 'currency', 'adults', 'children', 'cabin', 'maxStops', 'maxLayover', 'maxOutboundTries',
  'outDates', 'backDates', 'blockedCountries', 'airlines',
];

/** True if a change would make the stored prices wrong. */
export function searchChanged(a: WatchInput, b: WatchInput): boolean {
  return SEARCH_KEYS.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** PUT /api/watches/:id (full watch). Search changes clear old prices and cancel a running check. */
export async function updateWatch(ctx: Ctx, idText: string): Promise<Response> {
  const db = ctx.env.DB;
  const id = idParam(idText);
  const w = validateWatch(await readJson(ctx.request, 16_384), ctx.now);
  const [found] = await loadWatches(db, id);
  if (!found) throw new HttpError(404, 'Watch not found.');
  const reset = searchChanged(found.input, w);
  const statements = [
    db
      .prepare(
        `UPDATE watches SET name = ?, enabled = ?, origin = ?, destination = ?, currency = ?, adults = ?, children = ?, cabin = ?,
          max_stops = ?, max_layover = ?, max_outbound_tries = ?, out_from = ?, out_to = ?, back_from = ?, back_to = ?, budget = ?,
          reserve = ?, bags = ?, allow_unverified_bags = ?, pairs_per_run = ?, updated_at = ?,
          revision = revision + ?, cursor = CASE WHEN ? THEN 0 ELSE cursor END,
          lease_run_id = CASE WHEN ? THEN NULL ELSE lease_run_id END, lease_until = CASE WHEN ? THEN 0 ELSE lease_until END
         WHERE id = ?`,
      )
      .bind(w.name, w.enabled ? 1 : 0, w.origin, w.destination, w.currency, w.adults, w.children, w.cabin, w.maxStops, w.maxLayover,
        w.maxOutboundTries, w.outDates.from, w.outDates.to, w.backDates?.from ?? null, w.backDates?.to ?? null, w.budget, w.reserve,
        w.bags, w.allowUnverifiedBags ? 1 : 0, w.pairsPerRun, ctx.now, reset ? 1 : 0, reset ? 1 : 0, reset ? 1 : 0, reset ? 1 : 0, id),
    db.prepare('DELETE FROM watch_blocked_countries WHERE watch_id = ?').bind(id),
    db.prepare('DELETE FROM watch_airlines WHERE watch_id = ?').bind(id),
    ...childInserts(db, '?', [id], w),
  ];
  if (reset) statements.push(db.prepare('DELETE FROM watch_prices WHERE watch_id = ?').bind(id), db.prepare('DELETE FROM fare_alerts WHERE watch_id = ?').bind(id));
  await db.batch(statements);
  return json({ id, pricesCleared: reset });
}

/** PATCH /api/watches/:id {enabled} - quick pause / resume. */
export async function patchWatch(ctx: Ctx, idText: string): Promise<Response> {
  const id = idParam(idText);
  const body = asObject(await readJson(ctx.request, 1024));
  if (typeof body.enabled !== 'boolean') throw new InputError('enabled must be true or false.');
  const res = await ctx.env.DB.prepare('UPDATE watches SET enabled = ?, updated_at = ? WHERE id = ?').bind(body.enabled ? 1 : 0, ctx.now, id).run();
  if (!res.meta.changes) throw new HttpError(404, 'Watch not found.');
  return json({ id, enabled: body.enabled });
}

/** DELETE /api/watches/:id - removes the watch and everything stored for it. */
export async function deleteWatch(ctx: Ctx, idText: string): Promise<Response> {
  const db = ctx.env.DB;
  const id = idParam(idText);
  const results = await db.batch([
    db.prepare('DELETE FROM runner_job_pairs WHERE job_id IN (SELECT id FROM runner_jobs WHERE watch_id = ?)').bind(id),
    ...['runner_jobs', 'watch_runs', 'price_history', 'watch_prices', 'fare_alerts', 'fare_links', 'watch_airlines', 'watch_blocked_countries'].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE watch_id = ?`).bind(id)),
    db.prepare('DELETE FROM watches WHERE id = ?').bind(id),
  ]);
  if (!results[results.length - 1].meta.changes) throw new HttpError(404, 'Watch not found.');
  return json({ ok: true });
}
