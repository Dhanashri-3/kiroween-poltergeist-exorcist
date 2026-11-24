// Builds the Dashboard for the UI-contract e2e run and serves it with `vite preview`.
// VITE_API_BASE_URL is set for THIS build only, so the unchanged src/config.js points the
// Dashboard at the FAKE API harness. Output goes to .e2e-dist, never to dist/.
import { build, preview } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DASHBOARD_PORT, FAKE_API_BASE_URL } from './ports.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.VITE_API_BASE_URL = FAKE_API_BASE_URL;

await build({ root, logLevel: 'warn', build: { outDir: '.e2e-dist', emptyOutDir: true } });
const server = await preview({
  root,
  logLevel: 'warn',
  build: { outDir: '.e2e-dist' },
  preview: { host: '127.0.0.1', port: DASHBOARD_PORT, strictPort: true },
});
server.printUrls();

const stop = () => server.close().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
