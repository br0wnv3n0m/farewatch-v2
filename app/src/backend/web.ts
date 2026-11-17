// Web / phone backend. Everything goes to the watch server API.
// Live lookup cannot run in a phone browser; it shows lookups saved by the PC app.
import { createServerClient, syncedSettings } from './serverClient';
import type { Backend } from './types';

export const webBackend: Backend = {
  kind: 'web',
  canLookup: false,
  async engineInfo() {
    return null;
  },
  async startLookup() {
    throw new Error('Live lookup runs in the PC app. Open a saved lookup instead.');
  },
  loadSettings: syncedSettings.load,
  saveSettings: syncedSettings.save,
  openLink: async (url) => {
    window.open(url, '_blank', 'noopener');
  },
  server: createServerClient('Farewatch phone'),
};
