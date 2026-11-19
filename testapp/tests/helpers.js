// Shared helpers for the Test_App unit tests. Not a test file (not matched by *.test.js).
// Everything resolves relative to the testapp/ directory that contains this tests/ folder, so
// the same tests run unchanged against a temporary copy of testapp/.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(APP_DIR, 'public');
const requireFromApp = createRequire(path.join(APP_DIR, 'server.js'));

/** Load a real component/server source (CommonJS export path of the browser IIFEs). */
export function loadSource(relPath) {
  const full = path.join(APP_DIR, relPath);
  delete requireFromApp.cache[requireFromApp.resolve(full)];
  return requireFromApp(full);
}

export const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

/** Declarations of the first CSS rule whose selector list contains `selector`, or null. */
export function cssRule(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) {
      const decl = {};
      for (const d of m[2].split(';')) {
        const i = d.indexOf(':');
        if (i > 0) decl[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim().toLowerCase();
      }
      return decl;
    }
  }
  return null;
}

export function fakeDocument(ids) {
  const els = {};
  for (const id of ids) {
    const listeners = {};
    els[id] = {
      textContent: '',
      innerHTML: '',
      addEventListener(type, fn) { listeners[type] = fn; },
      click() { if (listeners.click) listeners.click(); },
    };
  }
  return { els, getElementById: (id) => els[id] || null };
}

/** Start the real Test_App server on an ephemeral loopback port. Never uses port 4100. */
export async function startServer() {
  const { createServer } = loadSource('server.js');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
