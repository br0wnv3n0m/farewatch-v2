// Desktop (Tauri) backend. The ONLY file that talks to Tauri.
// Lookup -> local Python engine (sidecar). Watches, saved lookups, settings -> watch server.
import { Command } from '@tauri-apps/plugin-shell';
import { createLineParser } from './lineParser';
import { createServerClient, syncedSettings } from './serverClient';
import type { Backend, EngineInfo, LookupEvent } from './types';

const ENGINE = 'binaries/farewatch-engine';

export const desktopBackend: Backend = {
  kind: 'desktop',
  canLookup: true,

  async engineInfo(): Promise<EngineInfo | null> {
    try {
      const out = await Command.sidecar(ENGINE, ['selftest']).execute();
      const info = JSON.parse(out.stdout.trim().split(/\r?\n/).pop() ?? '{}');
      return info.type === 'selftest' ? { version: info.version, airports: info.airports } : null;
    } catch (err) {
      console.error('engine selftest failed', err);
      return null;
    }
  },

  async startLookup(req, onEvent) {
    let finished = false;
    const emit = (e: LookupEvent) => {
      if (e.type === 'done' || e.type === 'fatal') finished = true;
      onEvent(e);
    };
    const cmd = Command.sidecar(ENGINE, ['lookup', '--watch-stdin']);
    const parse = createLineParser<LookupEvent>(emit, (line) => console.warn('engine:', line));
    cmd.stdout.on('data', parse);
    cmd.stderr.on('data', (line) => console.info('engine log:', line));
    cmd.on('error', (msg) => emit({ type: 'fatal', message: `Engine error: ${msg}` }));
    cmd.on('close', ({ code }) => {
      if (!finished) emit({ type: 'fatal', message: code === 130 ? 'Lookup cancelled.' : `Engine stopped unexpectedly (code ${code}).` });
    });
    const child = await cmd.spawn();
    await child.write(JSON.stringify(req) + '\n');
    return {
      async cancel() {
        if (finished) return;
        // Ask the engine to exit itself; kill as a fallback (see cli.py).
        try {
          await child.write('cancel\n');
        } catch {
          /* already gone */
        }
        setTimeout(() => void child.kill().catch(() => undefined), 1500);
      },
    };
  },

  loadSettings: syncedSettings.load,
  saveSettings: syncedSettings.save,
  server: createServerClient('Farewatch PC'),
};
