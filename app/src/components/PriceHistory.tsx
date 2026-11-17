// Price history of one watch: a line of the lowest price per day, a dashed "alert line"
// (budget minus reserve), and a table of every date combo. Tap a row to see that combo's
// own prices. Works on a phone: the chart scales to the width, the table scrolls sideways.
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Combo, ServerApi, Watch, WatchHistory } from '../backend/types';
import { ago, money, shortDate } from '../lib/format';

interface Props {
  server: ServerApi;
  watch: Watch;
  onBack: () => void;
}

interface Point {
  x: number; // ms timestamp
  y: number;
  label: string; // tooltip date text
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const comboText = (c: Combo) => (c.back ? `${shortDate(c.out)} → ${shortDate(c.back)}` : shortDate(c.out));
const DATE_TIME = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function PriceHistory({ server, watch, onBack }: Props) {
  const [data, setData] = useState<WatchHistory | null>(null);
  const [combo, setCombo] = useState<Combo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (c: Combo | null) => {
    try {
      setError(null);
      setData(await server.getHistory(watch.id, c ?? undefined));
    } catch (e) {
      setError(errorText(e));
    }
  }, [server, watch.id]);
  useEffect(() => { void load(combo); }, [load, combo]);

  const points = useMemo<Point[]>(() => {
    if (!data) return [];
    if (combo && data.points) return data.points.map((p) => ({ x: p.at, y: p.price, label: DATE_TIME.format(p.at) }));
    return data.days.map((d) => ({ x: Date.parse(d.day + 'T12:00:00Z'), y: d.low, label: shortDate(d.day) }));
  }, [data, combo]);

  if (error) return <section className="card"><p className="warn">{error}</p><button className="btn ghost" onClick={onBack}>Back</button></section>;
  if (!data) return <p className="muted">Loading…</p>;

  const currency = data.currency;
  const alertLine = data.budget - data.reserve; // price + reserve <= budget
  const lowest = points.length ? Math.min(...points.map((p) => p.y)) : null;
  const latest = points.length ? points[points.length - 1].y : null;

  return (
    <section className="results history">
      <div className="results-bar">
        <div>
          <button className="link" onClick={onBack}>← {watch.name}</button>
          <h2>Price history</h2>
          <div className="muted small">{watch.origin} → {watch.destination} · total for all travellers · current search settings only</div>
        </div>
        <button className="btn ghost" onClick={() => void load(combo)}>Refresh</button>
      </div>

      <div className="card">
        <div className="history-head">
          <div>
            <strong>{combo ? comboText(combo) : 'Lowest price per day, all dates'}</strong>
            {combo && <button className="link history-all" onClick={() => setCombo(null)}>Show all dates</button>}
          </div>
          <div className="history-stats small">
            <span>Lowest <span className="price-sm">{lowest === null ? '—' : money(lowest, currency)}</span></span>
            <span>Latest <span className="price-sm">{latest === null ? '—' : money(latest, currency)}</span></span>
            <span className="muted">Alert under {money(alertLine, currency)}</span>
          </div>
        </div>
        {points.length === 0 ? (
          <p className="muted small">No prices yet. History builds up with every check (about once an hour).</p>
        ) : (
          <LineChart points={points} threshold={alertLine} currency={currency} />
        )}
      </div>

      <div className="card">
        <strong>All date combinations</strong>
        <p className="muted small">Cheapest first. Tap a row to see its prices over time.</p>
        {data.combos.length === 0 ? (
          <p className="muted small">No prices for future dates yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr><th>Dates</th><th>Now</th><th>Lowest</th><th className="opt">Highest</th><th className="opt">Checks</th><th className="opt">Last</th></tr>
              </thead>
              <tbody>
                {data.combos.map((c) => {
                  const active = combo?.out === c.out && combo?.back === c.back;
                  const under = c.latest !== null && c.latest <= alertLine;
                  return (
                    <tr key={c.out + (c.back ?? '')} className={active ? 'active' : undefined} onClick={() => setCombo({ out: c.out, back: c.back })} tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') setCombo({ out: c.out, back: c.back }); }}>
                      <td>{comboText(c)}</td>
                      <td className="num">{c.latest === null ? '—' : money(c.latest, currency)}{under && <span className="badge">Under</span>}</td>
                      <td className="num">{money(c.low, currency)}</td>
                      <td className="num opt">{money(c.high, currency)}</td>
                      <td className="num opt">{c.checks}</td>
                      <td className="muted opt">{ago(c.lastAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- chart ----------

const H = 220; // px; the width follows the card, so text stays the same size on PC and phone
const PAD = { left: 64, right: 12, top: 12, bottom: 26 };

/** One series (accent colour), a dashed alert line, a crosshair + readout on hover / touch. */
function LineChart({ points, threshold, currency }: { points: Point[]; threshold: number; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ys = points.map((p) => p.y);
  let lo = Math.min(...ys, threshold);
  let hi = Math.max(...ys, threshold);
  const pad = Math.max((hi - lo) * 0.08, hi * 0.01, 1);
  lo -= pad;
  hi += pad;
  const x0 = points[0].x;
  const x1 = points[points.length - 1].x;
  const sx = (x: number) => PAD.left + (x1 === x0 ? (W - PAD.left - PAD.right) / 2 : ((x - x0) / (x1 - x0)) * (W - PAD.left - PAD.right));
  const sy = (y: number) => PAD.top + (1 - (y - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const shown = hover === null ? null : points[hover];

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(sx(p.x) - x) < Math.abs(sx(points[best].x) - x)) best = i; });
    setHover(best);
  };

  return (
    <div className="chart" ref={box}>
      <div className="chart-readout small" aria-live="polite">
        {shown ? <>{shown.label}: <span className="price-sm">{money(shown.y, currency)}</span></> : <span className="muted">Hover or tap the line for a price.</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Price over time" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} />
            <text className="axis" x={PAD.left - 6} y={sy(t) + 4} textAnchor="end">{money(t, currency)}</text>
          </g>
        ))}
        <line className="threshold" x1={PAD.left} x2={W - PAD.right} y1={sy(threshold)} y2={sy(threshold)} />
        <text className="axis" x={W - PAD.right} y={sy(threshold) - 5} textAnchor="end">alert line</text>
        <text className="axis" x={PAD.left} y={H - 6}>{points[0].label}</text>
        {points.length > 1 && <text className="axis" x={W - PAD.right} y={H - 6} textAnchor="end">{points[points.length - 1].label}</text>}
        <path className="series" d={path} />
        {points.length < 40 && points.map((p, i) => <circle key={i} className="dot" cx={sx(p.x)} cy={sy(p.y)} r={3} />)}
        {shown && (
          <>
            <line className="crosshair" x1={sx(shown.x)} x2={sx(shown.x)} y1={PAD.top} y2={H - PAD.bottom} />
            <circle className="dot active" cx={sx(shown.x)} cy={sy(shown.y)} r={5} />
          </>
        )}
      </svg>
    </div>
  );
}
