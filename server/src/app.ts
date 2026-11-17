// Router for the watch server. App routes need a session token (POST /api/login);
// runner routes need RUNNER_TOKEN. Kept out of index.ts: a Worker's main module
// may only export handlers.
import { login, logout, requireRunner, requireSession } from './auth.ts';
import { type Ctx, type Env, errorResponse, HttpError, json } from './http.ts';
import { deleteLookup, getLookup, listLookups, saveLookup } from './lookups.ts';
import { runnerDue, runnerJob, runnerReport, runnerStatus } from './runner.ts';
import { getSettings, putSettings } from './settings.ts';
import { createWatch, deleteWatch, getWatch, listWatches, patchWatch, updateWatch } from './watches.ts';

export const SERVER_VERSION = '2.0.0';

// Tauri on Windows serves the app from http://tauri.localhost; Vite dev uses localhost:1420.
const DEFAULT_ORIGINS = 'http://tauri.localhost,https://tauri.localhost,tauri://localhost,http://localhost:1420';

type Handler = (ctx: Ctx, ...params: string[]) => Promise<Response>;
interface Route { method: string; path: RegExp; auth: 'none' | 'session' | 'runner'; handler: Handler }

const ID = '(\\d+)';
const UUID = '([0-9a-f-]{36})';
const routes: Route[] = [
  { method: 'GET', path: /^\/api\/health$/, auth: 'none', handler: async () => json({ ok: true, version: SERVER_VERSION }) },
  { method: 'POST', path: /^\/api\/login$/, auth: 'none', handler: login },
  { method: 'POST', path: /^\/api\/logout$/, auth: 'session', handler: logout },
  { method: 'GET', path: /^\/api\/status$/, auth: 'session', handler: runnerStatus },
  { method: 'GET', path: /^\/api\/settings$/, auth: 'session', handler: getSettings },
  { method: 'PUT', path: /^\/api\/settings$/, auth: 'session', handler: putSettings },
  { method: 'GET', path: /^\/api\/watches$/, auth: 'session', handler: listWatches },
  { method: 'POST', path: /^\/api\/watches$/, auth: 'session', handler: createWatch },
  { method: 'GET', path: new RegExp(`^/api/watches/${ID}$`), auth: 'session', handler: getWatch },
  { method: 'PUT', path: new RegExp(`^/api/watches/${ID}$`), auth: 'session', handler: updateWatch },
  { method: 'PATCH', path: new RegExp(`^/api/watches/${ID}$`), auth: 'session', handler: patchWatch },
  { method: 'DELETE', path: new RegExp(`^/api/watches/${ID}$`), auth: 'session', handler: deleteWatch },
  { method: 'GET', path: /^\/api\/lookups$/, auth: 'session', handler: listLookups },
  { method: 'POST', path: /^\/api\/lookups$/, auth: 'session', handler: saveLookup },
  { method: 'GET', path: new RegExp(`^/api/lookups/${UUID}$`), auth: 'session', handler: getLookup },
  { method: 'DELETE', path: new RegExp(`^/api/lookups/${UUID}$`), auth: 'session', handler: deleteLookup },
  { method: 'POST', path: /^\/api\/runner\/due$/, auth: 'runner', handler: runnerDue },
  { method: 'POST', path: /^\/api\/runner\/job$/, auth: 'runner', handler: runnerJob },
  { method: 'POST', path: /^\/api\/runner\/report$/, auth: 'runner', handler: runnerReport },
];

function allowedOrigin(env: Env, origin: string | null): string | null {
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function withCors(res: Response, origin: string | null): Response {
  if (!origin) return res;
  const out = new Response(res.body, res);
  out.headers.set('Access-Control-Allow-Origin', origin);
  out.headers.set('Vary', 'Origin');
  return out;
}

export async function handle(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  const originHeader = request.headers.get('Origin');
  const origin = allowedOrigin(env, originHeader);

  // Browsers/webviews: only the app's own origins may call the API.
  if (originHeader && !origin && originHeader !== url.origin) return json({ error: 'Origin not allowed.' }, 403);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      },
    });
  }

  try {
    const matching = routes.filter((r) => r.path.test(url.pathname));
    if (!matching.length) throw new HttpError(404, 'Not found.');
    const route = matching.find((r) => r.method === request.method);
    if (!route) throw new HttpError(405, 'Method not allowed.');
    const ctx: Ctx = { env, request, url, now };
    if (route.auth === 'session') await requireSession(ctx);
    if (route.auth === 'runner') await requireRunner(ctx);
    const params = url.pathname.match(route.path)!.slice(1);
    return withCors(await route.handler(ctx, ...params), origin);
  } catch (err) {
    return withCors(errorResponse(err), origin);
  }
}
