// GET/PUT /api/settings: default "no layovers in" list, currency, alert email.
import { type Ctx, json, readJson } from './http.ts';
import { type SettingsInput, validateSettings } from './rules.ts';

export async function loadSettings(db: D1Database): Promise<SettingsInput> {
  const row = await db.prepare('SELECT currency, alert_email FROM settings WHERE id = 1').first<{ currency: string; alert_email: string | null }>();
  const list = await db.prepare('SELECT country FROM settings_blocked_countries ORDER BY country').all<{ country: string }>();
  return { currency: row?.currency ?? 'CAD', alertEmail: row?.alert_email ?? null, blockedCountries: list.results.map((r) => r.country) };
}

export async function getSettings(ctx: Ctx): Promise<Response> {
  return json(await loadSettings(ctx.env.DB));
}

export async function putSettings(ctx: Ctx): Promise<Response> {
  const s = validateSettings(await readJson(ctx.request, 8192));
  const db = ctx.env.DB;
  await db.batch([
    db.prepare('UPDATE settings SET currency = ?, alert_email = ?, updated_at = ? WHERE id = 1').bind(s.currency, s.alertEmail, ctx.now),
    db.prepare('DELETE FROM settings_blocked_countries'),
    db.prepare('INSERT INTO settings_blocked_countries (country) SELECT value FROM json_each(?)').bind(JSON.stringify(s.blockedCountries)),
  ]);
  return json(s);
}
