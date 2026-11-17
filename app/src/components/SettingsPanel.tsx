import { useState } from 'react';
import type { EngineInfo, ServerApi, Settings } from '../backend/types';
import { CountryPicker } from './CountryPicker';
import { ServerPanel } from './ServerPanel';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  engine: EngineInfo | null | undefined;
  backendKind: string;
  server: ServerApi;
  onServerChange: () => void;
  saveError: string | null;
}

export function SettingsPanel({ settings, onChange, engine, backendKind, server, onServerChange, saveError }: Props) {
  const [email, setEmail] = useState(settings.alertEmail ?? '');
  const emailOk = email === '' || /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
  return (
    <section className="card settings">
      <h2>Settings</h2>
      <h3>Watch server</h3>
      <ServerPanel server={server} onChange={onServerChange} />

      <h3>Defaults</h3>
      <p className="muted">Default list for new lookups and watches. You can change it per search.</p>
      <CountryPicker label="Never stop over in" value={settings.blockedCountries} onChange={(blockedCountries) => onChange({ ...settings, blockedCountries })} />
      <p className="muted small">
        Farewatch only applies this list. It does not know visa rules: check transit rules yourself. Flights through an airport that is not in the bundled list are removed when a list is set.
      </p>
      <label className="field small">
        <span className="label">Default currency</span>
        <input value={settings.currency} onChange={(e) => onChange({ ...settings, currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) })} />
      </label>
      {server.connection().signedIn && (
        <label className="field">
          <span className="label">Alert email (fares under budget, and a warning if checks stop)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value.trim())}
            onBlur={() => { if (emailOk) onChange({ ...settings, alertEmail: email || null }); }}
            placeholder="you@example.com"
          />
          {!emailOk && <span className="warn small">Not a valid email address.</span>}
        </label>
      )}
      {saveError && <p className="warn small">{saveError}</p>}

      <h3>Engine</h3>
      <p className="muted small">
        Mode: {backendKind}.{' '}
        {engine === undefined ? 'Checking…' : engine === null ? 'Flight engine not available on this device.' : `Engine ${engine.version}, ${engine.airports.toLocaleString()} airports.`}
      </p>
    </section>
  );
}
