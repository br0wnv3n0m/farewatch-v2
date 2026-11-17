// Picks the backend once at start-up. Tauri code is loaded only inside the app,
// so the web build never ships it.
import type { Backend } from './types';

export async function getBackend(): Promise<Backend> {
  if ('__TAURI_INTERNALS__' in window) return (await import('./desktop')).desktopBackend;
  if (import.meta.env.VITE_TARGET === 'web') return (await import('./web')).webBackend;
  return (await import('./demo')).demoBackend;
}

export type * from './types';
