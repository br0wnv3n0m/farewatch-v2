// GET /api/watches/:id/history[?out=YYYY-MM-DD&back=YYYY-MM-DD]
// Price history of the watch's current search settings (older revisions searched something else).
//   days:   lowest price seen per day (UTC), all dates of the watch together, last 365 days
//   combos: per future date combo: lowest, highest, latest, number of checks
//   points: every price of one combo (only when out/back are given), newest 500
import { type Ctx, HttpError, idParam, json } from './http.ts';
import { isoDate, todayUtc } from './rules.ts';

export async function getHistory(ctx: Ctx, idText: string): Promise<Response> {
  const db = ctx.env.DB;
  const id = idParam(idText);
  const w = await db.prepare('SELECT revision, currency, budget, reserve FROM watches WHERE id = ?').bind(id)
    .first<{ revision: number; currency: string; budget: number; reserve: number }>();
  if (!w) throw new HttpError(404, 'Watch not found.');
  const today = todayUtc(ctx.now);

  const [days, combos] = await db.batch<Record<string, unknown>>([
    db.prepare(
      `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, MIN(price) AS low
       FROM price_history WHERE watch_id = ? AND revision = ? GROUP BY day ORDER BY day`,
    ).bind(id, w.revision),
    db.prepare(
      `SELECT h.out_date AS out, h.back_date AS back, MIN(h.price) AS low, MAX(h.price) AS high, COUNT(*) AS checks,
              MAX(h.at) AS lastAt, p.price AS latest
       FROM price_history h
       LEFT JOIN watch_prices p ON p.watch_id = h.watch_id AND p.revision = h.revision AND p.out_date = h.out_date AND p.back_date = h.back_date
       WHERE h.watch_id = ? AND h.revision = ? AND h.out_date >= ?
       GROUP BY h.out_date, h.back_date ORDER BY low, h.out_date, h.back_date`,
    ).bind(id, w.revision, today),
  ]);

  let points: { at: number; price: number; airlines: string[] }[] | null = null;
  const outParam = ctx.url.searchParams.get('out');
  if (outParam) {
    const out = isoDate(outParam, 'out');
    const backParam = ctx.url.searchParams.get('back');
    const back = backParam ? isoDate(backParam, 'back') : '';
    const rows = await db.prepare(
      'SELECT at, price, airlines FROM price_history WHERE watch_id = ? AND revision = ? AND out_date = ? AND back_date = ? ORDER BY at DESC LIMIT 500',
    ).bind(id, w.revision, out, back).all<{ at: number; price: number; airlines: string }>();
    points = rows.results.reverse().map((r) => ({ at: r.at, price: r.price, airlines: r.airlines ? r.airlines.split(',') : [] }));
  }

  return json({
    currency: w.currency,
    budget: w.budget,
    reserve: w.reserve,
    days: days.results,
    combos: (combos.results as Record<string, unknown>[]).map((c) => ({ ...c, back: c.back || null })),
    points,
  });
}
