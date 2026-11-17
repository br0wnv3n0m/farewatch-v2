// Saved lookups: the PC app uploads each finished lookup so the phone can view it.
//   POST /api/lookups   GET /api/lookups   GET /api/lookups/:id   DELETE /api/lookups/:id
import { type Ctx, HttpError, json, readJson } from './http.ts';
import { asObject, type CellOption, combos, InputError, isoDate, LIMITS, sanitizeOption, searchRules } from './rules.ts';

interface LookupRow {
  id: string;
  created_at: number;
  origin: string;
  destination: string;
  currency: string;
  out_from: string;
  out_to: string;
  back_from: string | null;
  back_to: string | null;
  request_json: string;
  total: number;
  checked: number;
  best_price: number | null;
  complete: number;
}

const summary = (r: LookupRow) => ({
  id: r.id,
  createdAt: r.created_at,
  origin: r.origin,
  destination: r.destination,
  currency: r.currency,
  outDates: { from: r.out_from, to: r.out_to },
  backDates: r.back_from && r.back_to ? { from: r.back_from, to: r.back_to } : null,
  total: r.total,
  checked: r.checked,
  bestPrice: r.best_price,
  complete: r.complete === 1,
});

function range(o: Record<string, unknown>, key: string) {
  const w = asObject(o[key], key);
  const from = isoDate(w.from, key + '.from');
  const to = isoDate(w.to, key + '.to');
  if (to < from) throw new InputError(`${key}: "to" is before "from".`);
  return { from, to };
}

/** POST /api/lookups {request, cells, complete} -> {id} */
export async function saveLookup(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const body = asObject(await readJson(ctx.request, 2_000_000));
  const req = asObject(body.request, 'request');
  const rules = searchRules(req); // same field checks as a watch
  const outDates = range(req, 'outDates');
  const backDates = req.backDates === null || req.backDates === undefined ? null : range(req, 'backDates');
  // Saved lookups may be in the past already; count every combo, not only future ones.
  const all = combos(outDates, backDates, '0000-00-00');
  if (all.length > LIMITS.maxLookupCombos) throw new InputError(`At most ${LIMITS.maxLookupCombos} combinations.`);
  const valid = new Set(all.map((c) => `${c.out}|${c.back ?? ''}`));

  if (!Array.isArray(body.cells) || body.cells.length > all.length) throw new InputError('cells must be a list, one per date combination.');
  const seen = new Set<string>();
  const cells = body.cells.map((raw) => {
    const c = asObject(raw, 'cell');
    const out = isoDate(c.out, 'cell.out');
    const back = c.back === null || c.back === undefined ? null : isoDate(c.back, 'cell.back');
    const key = `${out}|${back ?? ''}`;
    if (!valid.has(key) || seen.has(key)) throw new InputError('A cell does not match the lookup dates.');
    seen.add(key);
    if (c.status !== 'ok' && c.status !== 'none' && c.status !== 'error') throw new InputError('cell.status must be ok, none or error.');
    const raws = Array.isArray(c.options) ? c.options : [];
    if (raws.length > LIMITS.maxOptionsPerCell) throw new InputError('Too many options in a cell.');
    const options: CellOption[] = c.status === 'ok' ? raws.map((o) => sanitizeOption(o, back !== null)).sort((a, b) => a.price - b.price) : [];
    const status = c.status === 'ok' && !options.length ? 'none' : (c.status as string);
    const message = typeof c.message === 'string' ? c.message.slice(0, 300) : null;
    return { out, back: back ?? '', status, options, message, price: options[0]?.price ?? null };
  });

  const id = crypto.randomUUID();
  const best = cells.reduce<number | null>((m, c) => (c.price !== null && (m === null || c.price < m) ? c.price : m), null);
  const request = { ...rules, outDates, backDates };
  await db.batch([
    db.prepare(
      `INSERT INTO lookups (id, created_at, origin, destination, currency, out_from, out_to, back_from, back_to, request_json, total, checked, best_price, complete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, ctx.now, rules.origin, rules.destination, rules.currency, outDates.from, outDates.to, backDates?.from ?? null,
      backDates?.to ?? null, JSON.stringify(request), all.length, cells.length, best, body.complete === true ? 1 : 0),
    ...cells.map((c) =>
      db.prepare('INSERT INTO lookup_cells (lookup_id, out_date, back_date, status, price, message, options_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, c.out, c.back, c.status, c.price, c.message, JSON.stringify(c.options))),
    // keep only the newest saved lookups
    db.prepare(`DELETE FROM lookup_cells WHERE lookup_id IN (SELECT id FROM lookups ORDER BY created_at DESC LIMIT -1 OFFSET ${LIMITS.savedLookups})`),
    db.prepare(`DELETE FROM lookups WHERE id IN (SELECT id FROM lookups ORDER BY created_at DESC LIMIT -1 OFFSET ${LIMITS.savedLookups})`),
  ]);
  return json({ id }, 201);
}

/** GET /api/lookups -> newest first */
export async function listLookups(ctx: Ctx): Promise<Response> {
  const res = await ctx.env.DB.prepare('SELECT * FROM lookups ORDER BY created_at DESC LIMIT ?').bind(LIMITS.savedLookups).all<LookupRow>();
  return json({ lookups: res.results.map(summary) });
}

/** GET /api/lookups/:id -> {lookup, request, cells} */
export async function getLookup(ctx: Ctx, id: string): Promise<Response> {
  const db = ctx.env.DB;
  const row = await db.prepare('SELECT * FROM lookups WHERE id = ?').bind(id).first<LookupRow>();
  if (!row) throw new HttpError(404, 'Saved lookup not found.');
  const cells = await db.prepare('SELECT out_date, back_date, status, price, message, options_json FROM lookup_cells WHERE lookup_id = ? ORDER BY out_date, back_date')
    .bind(id).all<{ out_date: string; back_date: string; status: string; price: number | null; message: string | null; options_json: string }>();
  const request = JSON.parse(row.request_json) as Record<string, unknown>;
  return json({
    lookup: summary(row),
    request,
    combos: combos(request.outDates as never, (request.backDates ?? null) as never, '0000-00-00'),
    cells: cells.results.map((c) => ({
      out: c.out_date,
      back: c.back_date || null,
      status: c.status,
      message: c.message ?? undefined,
      options: JSON.parse(c.options_json) as CellOption[],
    })),
  });
}

/** DELETE /api/lookups/:id */
export async function deleteLookup(ctx: Ctx, id: string): Promise<Response> {
  const db = ctx.env.DB;
  const results = await db.batch([
    db.prepare('DELETE FROM lookup_cells WHERE lookup_id = ?').bind(id),
    db.prepare('DELETE FROM lookups WHERE id = ?').bind(id),
  ]);
  if (!results[1].meta.changes) throw new HttpError(404, 'Saved lookup not found.');
  return json({ ok: true });
}
