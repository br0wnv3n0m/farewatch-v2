import type { Settings } from './types';

// Settings cache on this device. When signed in, the server copy wins (serverClient.ts).
const KEY = 'farewatch.settings.v1';
export const DEFAULT_SETTINGS: Settings = { blockedCountries: ['US'], currency: 'CAD', alertEmail: null };

export async function loadLocalSettings(): Promise<Settings> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      blockedCountries: Array.isArray(s.blockedCountries) ? s.blockedCountries.filter((c) => /^[A-Z]{2}$/.test(c)) : DEFAULT_SETTINGS.blockedCountries,
      currency: typeof s.currency === 'string' && /^[A-Z]{3}$/.test(s.currency) ? s.currency : DEFAULT_SETTINGS.currency,
      alertEmail: typeof s.alertEmail === 'string' ? s.alertEmail : null,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveLocalSettings(s: Settings): Promise<void> {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: keep in memory only */
  }
}
