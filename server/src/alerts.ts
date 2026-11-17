// Fare alert emails (Resend) and the fare detail pages they link to.
//
// Rule (kept from v1), per date combo of a watch:
//   - only fares under budget: price + reserve <= budget
//   - alert on a new fare, or when the price dropped at least 2% (min 1) and the last alert is over 24 h old
//   - watches with checked bags send nothing unless "alert even though bag costs are unverified" is on
// One digest email per watch per check: the 5 cheapest fares in full, the rest counted.
import { emailBlocker, emailLayout, esc, hmacHex, logEmail, sendEmail, sha256Hex, type SendResult } from './email.ts';
import { type Ctx, type Env, HttpError, json } from './http.ts';
import { type CellOption, type Leg, todayUtc, type WatchInput } from './rules.ts';
import { loadSettings } from './settings.ts';
import { loadWatches } from './watches.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const LINK_DAYS = 30;
const MAX_DETAILED = 5;

interface PriceRow {
  out_date: string;
  back_date: string;
  price: number;
  options_json: string;
  checked_at: number;
}
interface AlertRow {
  out_date: string;
  back_date: string;
  revision: number;
  price: number;
  at: number;
}

export interface Hit {
  out: string;
  back: string | null;
  price: number;
  option: CellOption;
  seenAt: number;
}

/** Saved on a fare page. Nothing private: no email, no budget, no watch name. */
interface FareSnapshot {
  origin: string;
  destination: string;
  currency: string;
  adults: number;
  children: number;
  cabin: number;
  bags: number;
  reserve: number;
  out: string;
  back: string | null;
  price: number;
  seenAt: number;
  option: CellOption;
}

/** v1 alert rule for one combo. */
export function shouldAlert(price: number, previous: { price: number; at: number } | null, now: number): boolean {
  if (!previous) return true;
  return price <= previous.price - Math.max(1, previous.price * 0.02) && now - previous.at > DAY;
}

// ---------- formatting ----------

export function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${Math.round(value)} ${currency}`;
  }
}

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
export const shortDate = (iso: string) => DAY_FMT.format(new Date(iso + 'T00:00:00Z'));
const datesText = (out: string, back: string | null) => (back ? `${shortDate(out)} → ${shortDate(back)}` : `${shortDate(out)} · one way`);
const CABINS = ['', 'Economy', 'Premium economy', 'Business', 'First'];
const stopsText = (leg: Leg) => (leg.layovers.length === 0 ? 'nonstop' : `${leg.layovers.length} stop${leg.layovers.length > 1 ? 's' : ''} via ${leg.layovers.map((l) => l.id).join(', ')}`);
const people = (w: { adults: number; children: number }) => w.adults + w.children;

function googleFlightsUrl(s: { origin: string; destination: string; out: string; back: string | null; adults: number; children: number; currency: string }): string {
  const q = `Flights from ${s.origin} to ${s.destination} on ${s.out}${s.back ? ' returning ' + s.back : ''} for ${s.adults} adults${s.children ? ' and ' + s.children + ' children' : ''} ${s.currency}`;
  return 'https://www.google.com/travel/flights?q=' + encodeURIComponent(q);
}

export function publicUrl(env: Env): string {
  return (env.PUBLIC_URL || 'https://farewatch-v2.farewatch.workers.dev').replace(/\/+$/, '');
}

// ---------- fare links ----------

async function linkSecret(db: D1Database): Promise<string> {
  const row = await db.prepare('SELECT link_secret FROM settings WHERE id = 1').first<{ link_secret: string | null }>();
  if (row?.link_secret) return row.link_secret;
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.prepare('UPDATE settings SET link_secret = ? WHERE id = 1 AND link_secret IS NULL').bind(fresh).run();
  const again = await db.prepare('SELECT link_secret FROM settings WHERE id = 1').first<{ link_secret: string }>();
  return again!.link_secret;
}

// ---------- the digest ----------

/** Fares of one watch that pass the alert rule now. Exported for tests. */
export async function findHits(db: D1Database, watchId: number, now: number): Promise<{ w: WatchInput; revision: number; hits: Hit[]; underBudget: number } | null> {
  const [found] = await loadWatches(db, watchId);
  if (!found || !found.input.enabled) return null;
  const w = found.input;
  const revision = found.row.revision;
  const [prices, alerts] = await Promise.all([
    db.prepare("SELECT out_date, back_date, price, options_json, checked_at FROM watch_prices WHERE watch_id = ? AND revision = ? AND status = 'ok' AND out_date >= ? AND price + ? <= ?")
      .bind(watchId, revision, todayUtc(now), w.reserve, w.budget).all<PriceRow>(),
    db.prepare('SELECT out_date, back_date, revision, price, at FROM fare_alerts WHERE watch_id = ?').bind(watchId).all<AlertRow>(),
  ]);
  const last = new Map(alerts.results.filter((a) => a.revision === revision).map((a) => [a.out_date + '|' + a.back_date, a]));
  const hits: Hit[] = [];
  for (const p of prices.results) {
    if (!shouldAlert(p.price, last.get(p.out_date + '|' + p.back_date) ?? null, now)) continue;
    const option = (JSON.parse(p.options_json) as CellOption[])[0];
    if (option) hits.push({ out: p.out_date, back: p.back_date || null, price: p.price, option, seenAt: p.checked_at });
  }
  hits.sort((a, b) => a.price - b.price || a.out.localeCompare(b.out) || (a.back ?? '').localeCompare(b.back ?? ''));
  return { w, revision, hits, underBudget: prices.results.length };
}

/**
 * Send the fare digest for one watch if anything passes the rule. Never throws for email
 * problems: they go to the email log and are retried on the next check (fares are only
 * marked as alerted after Resend accepts the email).
 */
export async function sendFareAlerts(env: Env, watchId: number, now: number): Promise<SendResult | null> {
  const db = env.DB;
  const found = await findHits(db, watchId, now);
  if (!found || !found.hits.length) return null;
  const { w, revision, hits } = found;
  if (w.bags > 0 && !w.allowUnverifiedBags) return null; // no consent: bag costs are never verified
  const settings = await loadSettings(db);
  if (emailBlocker(env, settings.alertEmail)) return null; // shown in Settings, not logged every hour

  // Same fares + prices on the same day = same key = Resend sends it once.
  const day = todayUtc(now);
  const key = 'fw2-fares-' + (await sha256Hex(JSON.stringify([watchId, revision, day, hits.map((h) => [h.out, h.back, h.price, h.option.airlines])])));
  const secret = await linkSecret(db);
  const detailed = hits.slice(0, MAX_DETAILED);
  const links: string[] = [];
  const inserts: D1PreparedStatement[] = [];
  for (const [i, h] of detailed.entries()) {
    const token = (await hmacHex(secret, `${key}:${i}`)).slice(0, 32); // deterministic: a retry builds the same email
    const snap: FareSnapshot = {
      origin: w.origin, destination: w.destination, currency: w.currency, adults: w.adults, children: w.children, cabin: w.cabin,
      bags: w.bags, reserve: w.reserve, out: h.out, back: h.back, price: h.price, seenAt: h.seenAt, option: h.option,
    };
    inserts.push(
      db.prepare('INSERT OR IGNORE INTO fare_links (token_hash, watch_id, data_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(await sha256Hex(token), watchId, JSON.stringify(snap), now, now + LINK_DAYS * DAY),
    );
    links.push(`${publicUrl(env)}/fare/${token}`);
  }
  await db.batch(inserts);

  const result = await sendEmail(env, { to: settings.alertEmail!, ...fareDigest(w, hits, links) }, key);
  if (result.ok) {
    await db.batch(hits.map((h) =>
      db.prepare(
        `INSERT INTO fare_alerts (watch_id, revision, out_date, back_date, price, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (watch_id, out_date, back_date) DO UPDATE SET revision = excluded.revision, price = excluded.price, at = excluded.at`,
      ).bind(watchId, revision, h.out, h.back ?? '', h.price, now)));
  }
  await logEmail(db, now, 'fares', watchId, {
    ok: result.ok,
    message: result.ok ? `${w.name}: ${hits.length} fare${hits.length > 1 ? 's' : ''} sent.` : `${w.name}: ${result.message}`,
  });
  return result;
}

/** Subject, HTML and text of the digest. Depends only on its inputs (see the idempotency key). */
export function fareDigest(w: WatchInput, hits: Hit[], links: string[]): { subject: string; html: string; text: string } {
  const n = hits.length;
  const best = hits[0];
  const subject = `Farewatch: ${w.origin}–${w.destination} from ${money(best.price, w.currency)} (${n} fare${n > 1 ? 's' : ''} under budget)`;
  const party = `${people(w)} traveller${people(w) > 1 ? 's' : ''} · ${CABINS[w.cabin] ?? ''}`;
  const bagNote = w.bags
    ? `You asked for ${w.bags} checked bag${w.bags > 1 ? 's' : ''} per traveller. Bag costs are not in these prices and are not verified.`
    : 'Checked-bag costs are not in these prices and are not verified.';
  const rows = links.map((link, i) => {
    const h = hits[i];
    const legs = [h.option.out, ...(h.option.back ? [h.option.back] : [])];
    return `<tr><td style="padding:14px 0;border-top:1px solid #e3e9e5">
<div style="font-size:15px;font-weight:700">${esc(datesText(h.out, h.back))}</div>
<div style="font-size:13px;color:#5d6f65;margin-top:3px">${esc(h.option.airlines.join(' + ') || 'Airline not shown')} · ${esc(legs.map(stopsText).join(' / '))}</div>
<div style="margin-top:6px"><span style="font-size:22px;font-weight:700;font-family:Consolas,Menlo,monospace">${esc(money(h.price, w.currency))}</span>
${w.reserve ? `<span style="font-size:13px;color:#5d6f65"> · ${esc(money(h.price + w.reserve, w.currency))} with your reserve</span>` : ''}</div>
<a href="${esc(link)}" style="display:inline-block;margin-top:10px;background:#16a34a;color:#ffffff;text-decoration:none;padding:9px 14px;border-radius:8px;font-size:14px;font-weight:700">View fare details</a>
</td></tr>`;
  }).join('');
  const more = n > links.length ? `<p style="font-size:13px;color:#5d6f65">${n - links.length} more fare${n - links.length > 1 ? 's' : ''} under budget. Open the watch in Farewatch to see all dates.</p>` : '';
  const body = `<h1 style="font-size:22px;margin:8px 0 4px">${esc(w.origin)} → ${esc(w.destination)}</h1>
<div style="font-size:14px;color:#5d6f65">${esc(w.name)} · ${esc(party)} · budget ${esc(money(w.budget, w.currency))}</div>
<p style="font-size:14px">Prices are the total for all travellers.</p>
<table role="presentation" width="100%" style="border-collapse:collapse">${rows}</table>${more}`;
  const footer = `${esc(bagNote)} Prices and seats can change at any time; check before you book.<br><br>
Fare links work for ${LINK_DAYS} days. Anyone with a link can see that one itinerary, nothing else.<br>
You get this because alerts are on for this watch. Pause the watch in Farewatch to stop them.`;
  const text = [
    `${w.origin} → ${w.destination} · ${w.name} · ${party}`,
    'Prices are the total for all travellers.',
    '',
    ...links.map((link, i) => {
      const h = hits[i];
      return `${datesText(h.out, h.back)}: ${money(h.price, w.currency)}${w.reserve ? ` (${money(h.price + w.reserve, w.currency)} with reserve)` : ''} · ${h.option.airlines.join(' + ')}\n${link}`;
    }),
    ...(n > links.length ? ['', `${n - links.length} more under budget in the app.`] : []),
    '',
    bagNote,
    `Prices can change. Fare links work for ${LINK_DAYS} days.`,
  ].join('\n');
  return { subject, html: emailLayout(subject, body, footer), text };
}

// ---------- fare page (public, from email links) ----------

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

const PAGE_CSS = `body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#f1f5f2;color:#17301f}
main{max-width:640px;margin:0 auto;padding:20px 14px 40px}.card{background:#fff;border:1px solid #e3e9e5;border-radius:14px;padding:16px;margin-top:12px}
h1{font-size:1.4rem;margin:.4rem 0}.muted{color:#5d6f65}.small{font-size:.85rem}.price{font-family:Consolas,Menlo,monospace;font-size:1.8rem;font-weight:700}
.flight{padding:8px 0;border-top:1px solid #eef2ef}.lay{font-size:.85rem;color:#5d6f65;border-left:3px solid #16a34a;padding:2px 8px;margin:4px 0}
a.btn{display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700;margin-top:10px}
.brand{font-weight:700}.brand span{color:#16a34a}`;

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main><div class="brand">Farewatch <span>&#9679;</span></div>${inner}</main></body></html>`;
}

function legHtml(label: string, leg: Leg): string {
  const parts: string[] = [];
  leg.flights.forEach((f, i) => {
    parts.push(`<div class="flight"><strong>${esc(f.departure_airport.id)} → ${esc(f.arrival_airport.id)}</strong> · ${esc(f.flight_number)} ${esc(f.airline)}<div class="small muted">${esc(f.departure_airport.time)} → ${esc(f.arrival_airport.time)} (local times)</div></div>`);
    const l = leg.layovers[i];
    if (l && i < leg.flights.length - 1)
      parts.push(`<div class="lay">Layover ${esc(l.id)}${l.country ? ' (' + esc(l.country) + ')' : ''} · ${Math.floor(l.duration / 60)}h ${String(l.duration % 60).padStart(2, '0')}m</div>`);
  });
  return `<section class="card"><h2 style="font-size:1rem;margin:0 0 4px">${esc(label)} · ${esc(stopsText(leg))}</h2>${parts.join('')}</section>`;
}

/** GET /fare/:token */
export async function farePage(ctx: Ctx, token: string): Promise<Response> {
  if (!/^[0-9a-f]{32}$/.test(token)) throw new HttpError(404, 'Not found.');
  const row = await ctx.env.DB.prepare('SELECT data_json, expires_at FROM fare_links WHERE token_hash = ?').bind(await sha256Hex(token))
    .first<{ data_json: string; expires_at: number }>();
  if (!row || row.expires_at < ctx.now) {
    const html = page('Fare link unavailable', `<section class="card"><h1>This fare link has expired.</h1><p class="muted">Fare links work for ${LINK_DAYS} days. Open Farewatch to see current prices.</p></section>`);
    return new Response(html, { status: row ? 410 : 404, headers: PAGE_HEADERS });
  }
  const s = JSON.parse(row.data_json) as FareSnapshot;
  const n = people(s);
  const seen = new Date(s.seenAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const inner = `<h1>${esc(s.origin)} → ${esc(s.destination)}</h1>
<div class="muted">${esc(datesText(s.out, s.back))} · ${n} traveller${n > 1 ? 's' : ''} · ${esc(CABINS[s.cabin] ?? '')}</div>
<section class="card"><div class="small muted">Total for all travellers</div><div class="price">${esc(money(s.price, s.currency))}</div>
<div class="small muted">${esc(money(s.price / n, s.currency))} per traveller${s.reserve ? ` · ${esc(money(s.price + s.reserve, s.currency))} with your reserve` : ''}</div>
<p class="small muted">Seen ${esc(seen)}. This is a saved price, not a live one.</p>
<a class="btn" href="${esc(googleFlightsUrl(s))}" target="_blank" rel="noopener noreferrer">Search these dates on Google Flights</a></section>
${legHtml('Outbound', s.option.out)}${s.option.back ? legHtml('Return', s.option.back) : ''}
<section class="card small muted">${s.bags ? `${s.bags} checked bag${s.bags > 1 ? 's' : ''} per traveller requested. ` : ''}Bag allowance and fees are not verified. Check the flights, total price, bags and transit rules before you pay.<br><br>Anyone with this link can see this itinerary. The link expires ${LINK_DAYS} days after the alert.</section>`;
  return new Response(ctx.request.method === 'HEAD' ? null : page(`${s.origin} → ${s.destination} · Farewatch`, inner), { headers: PAGE_HEADERS });
}

// ---------- test email (app: Settings) ----------

/** POST /api/alerts/test */
export async function sendTestEmail(ctx: Ctx): Promise<Response> {
  const { env, now } = ctx;
  const settings = await loadSettings(env.DB);
  const blocker = emailBlocker(env, settings.alertEmail);
  if (blocker) throw new HttpError(409, blocker);
  const subject = 'Farewatch: test email';
  const html = emailLayout(subject, '<h1 style="font-size:20px">Email works.</h1><p style="font-size:14px">Fare alerts and "checks have stopped" warnings will arrive at this address.</p>', 'Sent from Settings in the Farewatch app.');
  const result = await sendEmail(env, { to: settings.alertEmail!, subject, html, text: 'Email works. Fare alerts and "checks have stopped" warnings will arrive at this address.' }, 'fw2-test-' + crypto.randomUUID());
  await logEmail(env.DB, now, 'test', null, result);
  if (!result.ok) throw new HttpError(502, result.message);
  return json({ message: `Test email sent to ${settings.alertEmail}. Check the inbox and the spam folder.` });
}
