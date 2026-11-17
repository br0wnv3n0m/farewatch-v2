import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Phone home-screen tags. Added only to the web build (npm run build:web, step 5),
// so the Tauri app does not ask for files it does not have.
const phoneTags: Plugin = {
  name: 'farewatch-phone-tags',
  transformIndexHtml: () => [
    { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' }, injectTo: 'head' },
    { tag: 'link', attrs: { rel: 'icon', type: 'image/png', href: '/favicon.png' }, injectTo: 'head' },
    { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'Farewatch' }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'format-detection', content: 'telephone=no' }, injectTo: 'head' },
  ],
};

// Tauri expects a fixed port and must see Rust errors in the terminal.
// "--mode web" builds the phone version into dist-web (served by the server Worker).
export default defineConfig(({ mode }) => {
  const web = mode === 'web';
  return {
    plugins: web ? [react(), phoneTags] : [react()],
    clearScreen: false,
    server: { port: 1420, strictPort: true },
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    publicDir: web ? 'public-web' : false,
    build: { target: web ? 'safari15' : 'es2021', sourcemap: false, outDir: web ? 'dist-web' : 'dist' },
  };
});
