import { useMemo } from 'react';
import type { Combo } from '../backend/types';
import { money, shortDate } from '../lib/format';
import { axes, cellKey, tiers, visibleOptions, type CellState } from '../lib/grid';

interface Props {
  combos: Combo[];
  cells: Map<string, CellState>;
  airline: string;
  currency: string;
  selected: string | null;
  onSelect: (key: string) => void;
  /** How to show a combo with no data: 'pending' (search running) or 'unchecked' (watch not there yet). */
  missing?: 'pending' | 'unchecked';
}

/** Leave dates down the side, return dates across. Scrolls sideways on phones. */
export function PriceGrid({ combos, cells, airline, currency, selected, onSelect, missing = 'pending' }: Props) {
  const { outs, backs, oneWay } = useMemo(() => axes(combos), [combos]);
  const valid = useMemo(() => new Set(combos.map((c) => cellKey(c.out, c.back))), [combos]);
  const colour = useMemo(() => {
    const prices = new Map<string, number>();
    for (const [key, cell] of cells) {
      const best = visibleOptions(cell, airline)[0];
      if (best) prices.set(key, best.price);
    }
    return tiers(prices);
  }, [cells, airline]);

  const renderCell = (key: string) => {
    if (!valid.has(key)) return <td key={key} className="cell void" aria-hidden />;
    const cell = cells.get(key);
    const best = visibleOptions(cell, airline)[0];
    let content: React.ReactNode;
    let cls = 'cell';
    if (!cell && missing === 'unchecked') { content = '·'; cls += ' none'; }
    else if (!cell || cell.status === 'pending') { content = <span className="dots" aria-label="Searching" />; cls += ' pending'; }
    else if (cell.status === 'error') { content = '!'; cls += ' error'; }
    else if (!best) { content = '—'; cls += ' none'; }
    else { content = money(best.price, currency); cls += ' ' + colour.get(key); }
    if (key === selected) cls += ' selected';
    const title = !cell && missing === 'unchecked' ? 'Not checked yet' : cell?.status === 'error' ? cell.message : cell?.status === 'none' || (cell && !best) ? 'No allowed flight' : undefined;
    return (
      <td key={key} className={cls} title={title}>
        <button type="button" onClick={() => onSelect(key)} disabled={!cell || cell.status === 'pending'}>{content}</button>
      </td>
    );
  };

  return (
    <div className="grid-scroll">
      <table className="price-grid">
        <thead>
          <tr>
            <th className="corner">{oneWay ? 'Leave' : 'Leave ↓ / Return →'}</th>
            {(oneWay ? outs : backs).map((d) => <th key={d}>{shortDate(d)}</th>)}
          </tr>
        </thead>
        <tbody>
          {oneWay ? (
            <tr>
              <th>One way</th>
              {outs.map((o) => renderCell(cellKey(o, null)))}
            </tr>
          ) : (
            outs.map((o) => (
              <tr key={o}>
                <th>{shortDate(o)}</th>
                {backs.map((b) => renderCell(cellKey(o, b)))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
