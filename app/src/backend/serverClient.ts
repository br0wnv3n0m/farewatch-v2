// Watch server client (v2/server). Used by the desktop and web backends.
// Plain fetch with a bearer token; the server allows the app's origins (CORS).
import { DEFAULT_SETTINGS, loadLocalSettings, saveLocalSettings } from './localSettings';
import type { RunnerStatus, SavedLookupSummary, ServerApi, Settings, Watch } from './types';

const KEY = 'farewatch.server.v1';

interface Stored {
  url: string;
  token: string | null;
}

function read(): Stored | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
    return s && typeof s.url === 'string' ? s : null;
  } catch {
    return null;
  }
}

function write(s: Stored | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

/** "farewatch-v2.me.workers.dev" -> "https://farewatch-v2.me.workers.dev". Only https is accepted. */
export function normalizeUrl(input: string): string {
  const text = input.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : 'https://' + text);
  } catch {
    throw new Error('That is not a valid server address.');
  }
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'); // wrangler dev
  if (url.protocol !== 'https:' && !local) throw new Error('The server address must start with https://');
  return url.origin;
}

export class ServerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One API call. A 401 forgets the token so the app asks to sign in again. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const s = read();
  if (!s?.url) throw new ServerError(0, 'Set up the watch server in Settings first.');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (s.token) headers.Authorization = 'Bearer ' + s.token;
  let res: Response;
  try {
    res = await fetch(s.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ServerError(0, 'Could not reach the watch server. Check the internet connection.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && path !== '/api/login') write({ url: s.url, token: null });
  if (!res.ok) throw new ServerError(res.status, data.error ?? `Server returned HTTP ${res.status}.`);
  return data as T;
}

/** label: shown on the server next to the session ("Farewatch PC", "Farewatch phone"). */
export function createServerClient(label: string): ServerApi {
  return {
    connection() {
      const s = read();
      return { url: s?.url ?? null, signedIn: !!s?.token };
    },
    async signIn(url, password) {
      const origin = normalizeUrl(url);
      write({ url: origin, token: null });
      const r = await call<{ token: string }>('POST', '/api/login', { password, label });
      write({ url: origin, token: r.token });
    },
    async signOut() {
      try {
        await call('POST', '/api/logout');
      } catch {
        /* forget the token anyway */
      } finally {
        const s = read();
        write(s ? { url: s.url, token: null } : null);
      }
    },
    runnerStatus: async () => (await call<{ runner: RunnerStatus }>('GET', '/api/status')).runner,
    listWatches: async () => (await call<{ watches: Watch[] }>('GET', '/api/watches')).watches,
    getWatch: (id) => call('GET', `/api/watches/${id}`),
    createWatch: async (w) => (await call<{ id: number }>('POST', '/api/watches', w)).id,
    updateWatch: (id, w) => call('PUT', `/api/watches/${id}`, w),
    setWatchEnabled: async (id, enabled) => void (await call('PATCH', `/api/watches/${id}`, { enabled })),
    deleteWatch: async (id) => void (await call('DELETE', `/api/watches/${id}`)),
    saveLookup: async (request, cells, complete) => (await call<{ id: string }>('POST', '/api/lookups', { request, cells, complete })).id,
    listLookups: async () => (await call<{ lookups: SavedLookupSummary[] }>('GET', '/api/lookups')).lookups,
    getLookup: (id) => call('GET', `/api/lookups/${id}`),
    deleteLookup: async (id) => void (await call('DELETE', `/api/lookups/${id}`)),
  };
}

/** Settings: the server copy when signed in (cached on this device), the device copy otherwise. */
export const syncedSettings = {
  async load(): Promise<Settings> {
    const local = await loadLocalSettings();
    if (!read()?.token) return local;
    try {
      const remote = { ...DEFAULT_SETTINGS, ...(await call<Settings>('GET', '/api/settings')) };
      await saveLocalSettings(remote);
      return remote;
    } catch {
      return local; // offline: use the cached copy
    }
  },
  async save(next: Settings): Promise<void> {
    await saveLocalSettings(next);
    if (read()?.token) await call('PUT', '/api/settings', next);
  },
};
