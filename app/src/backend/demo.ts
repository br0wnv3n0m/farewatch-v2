// Demo backend: fake prices, used when the UI runs in a normal browser
// ("npm run dev" without Tauri). Lets you work on screens without searching Google.
import { buildCombos } from '../lib/grid';
import { demoServer } from './demoServer';
import { loadLocalSettings, saveLocalSettings } from './localSettings';
import { fakeOptions } from './demoData';
import type { Backend, Combo, LookupEvent, LookupRequest } from './types';

const combos = (req: LookupRequest): Combo[] => buildCombos(req.outDates, req.backDates);

export const demoBackend: Backend = {
  kind: 'demo',
  canLookup: true,
  async engineInfo() {
    return { version: 'demo', airports: 0 };
  },
  async startLookup(req, onEvent: (e: LookupEvent) => void) {
    const list = combos(req);
    let i = 0;
    let stopped = false;
    onEvent({ type: 'start', total: list.length, combos: list });
    const timer = setInterval(() => {
      if (stopped) return;
      if (i >= list.length) {
        clearInterval(timer);
        onEvent({ type: 'done', checked: list.length });
        return;
      }
      const c = list[i];
      const options = i % 11 === 7 ? [] : fakeOptions(req, c, i + 3);
      onEvent({ type: 'cell', out: c.out, back: c.back, status: options.length ? 'ok' : 'none', options });
      i++;
    }, 120);
    return {
      async cancel() {
        stopped = true;
        clearInterval(timer);
        onEvent({ type: 'fatal', message: 'Lookup cancelled.' });
      },
    };
  },
  loadSettings: loadLocalSettings,
  saveSettings: saveLocalSettings,
  openLink: async (url) => {
    window.open(url, '_blank', 'noopener');
  },
  server: demoServer,
};
