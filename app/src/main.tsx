import '@fontsource-variable/dm-sans';
import '@fontsource-variable/space-grotesk';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { getBackend } from './backend';
import './styles.css';

async function start() {
  const backend = await getBackend();
  const settings = await backend.loadSettings();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App backend={backend} initialSettings={settings} />
    </StrictMode>,
  );
}

void start();
