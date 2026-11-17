export function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${Math.round(value)} ${currency}`;
  }
}

export function minutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  return h ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}

const DAY = new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
export function shortDate(iso: string): string {
  return DAY.format(new Date(iso + 'T00:00:00Z'));
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
}

export function clock(stamp: string): string {
  return stamp.slice(11, 16);
}

/** "5 min ago", "3 h ago", "2 days ago" from a ms timestamp. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const min = Math.round((now - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "Dec 20 – Dec 22" for a date range. */
export function rangeText(r: { from: string; to: string }): string {
  return r.from === r.to ? shortDate(r.from) : `${shortDate(r.from)} – ${shortDate(r.to)}`;
}
