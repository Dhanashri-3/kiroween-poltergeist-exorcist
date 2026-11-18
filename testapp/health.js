'use strict';

// Real health checks. Every call re-reads the component files from disk and
// exercises their behavior, so a modified file changes the result.
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, 'public');

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

// Evaluate a component source in an isolated context and return its exports.
function loadModule(name) {
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports };
  vm.runInNewContext(readPublic(name), sandbox, { filename: name, timeout: 1000 });
  return module.exports;
}

// Return declarations of the first rule whose selector list contains `selector`.
function cssDeclarations(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) {
      const decl = {};
      m[2].split(';').forEach((d) => {
        const i = d.indexOf(':');
        if (i > 0) decl[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim().toLowerCase();
      });
      return decl;
    }
  }
  return null;
}

function fakeElement() {
  const listeners = {};
  return {
    textContent: '',
    innerHTML: '',
    addEventListener(type, fn) { listeners[type] = fn; },
    click() { if (listeners.click) listeners.click(); },
  };
}

function fakeDocument(ids) {
  const els = {};
  ids.forEach((id) => { els[id] = fakeElement(); });
  return { els, getElementById: (id) => els[id] || null };
}

function httpGetJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function htmlHas(html, id) {
  return new RegExp('id="' + id + '"').test(html);
}

async function checkButton() {
  const html = readPublic('index.html');
  if (!htmlHas(html, 'test-button')) throw new Error('#test-button missing from index.html');
  if (!html.includes('/button.js')) throw new Error('button.js is not included by index.html');
  const mod = loadModule('button.js');
  const doc = fakeDocument(['test-button', 'button-output']);
  mod.mount(doc);
  doc.els['test-button'].click();
  doc.els['test-button'].click();
  if (doc.els['button-output'].textContent !== 'Clicked 2 times') {
    throw new Error('click handler produced "' + doc.els['button-output'].textContent + '"');
  }
  const css = cssDeclarations(readPublic('button.css'), '#test-button');
  if (!css || css.display === 'none') throw new Error('button style missing or hidden');
}

async function checkLayout() {
  const html = readPublic('index.html');
  if (!/class="layout-section"/.test(html)) throw new Error('.layout-section missing from index.html');
  if (!html.includes('/layout.css')) throw new Error('layout.css is not included by index.html');
  const d = cssDeclarations(readPublic('layout.css'), '.layout-section');
  if (!d) throw new Error('.layout-section rule missing');
  if (!['grid', 'flex'].includes(d.display)) throw new Error('.layout-section display is "' + d.display + '"');
  if (d.visibility === 'hidden') throw new Error('.layout-section is hidden');
  if (!/^\d+(px|%|rem|em)?$/.test((d.padding || '').split(' ')[0])) throw new Error('.layout-section padding invalid');
}

async function checkDataPanel(ctx) {
  const res = await httpGetJson(ctx.port, '/api/items');
  if (res.status !== 200) throw new Error('mock API returned HTTP ' + res.status);
  if (!Array.isArray(res.body.items) || res.body.items.length === 0) throw new Error('mock API returned no items');
  const mod = loadModule('data-panel.js');
  const doc = fakeDocument(['data-panel-content']);
  const fetchFn = (url) => httpGetJson(ctx.port, url).then((r) => ({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: () => Promise.resolve(r.body),
  }));
  await mod.load(fetchFn, doc);
  const out = doc.els['data-panel-content'].innerHTML;
  if (!out.includes(res.body.items[0].name)) throw new Error('data panel did not render API data');
  if (!htmlHas(readPublic('index.html'), 'data-panel-content')) throw new Error('#data-panel-content missing');
}

async function checkCard() {
  const html = readPublic('index.html');
  if (!htmlHas(html, 'test-card')) throw new Error('#test-card missing from index.html');
  if (!html.includes('/card.css')) throw new Error('card.css is not included by index.html');
  const d = cssDeclarations(readPublic('card.css'), '.card');
  if (!d) throw new Error('.card rule missing');
  for (const prop of ['background', 'border', 'padding']) {
    if (!d[prop]) throw new Error('.card is missing "' + prop + '"');
  }
  if (d.display === 'none' || d.visibility === 'hidden') throw new Error('.card is hidden');
  const mod = loadModule('card.js');
  const doc = fakeDocument(['test-card']);
  mod.mount(doc);
  if (!doc.els['test-card'].innerHTML.includes('card-title')) throw new Error('card did not render');
}

const CHECKS = {
  button: checkButton,
  layout: checkLayout,
  dataPanel: checkDataPanel,
  card: checkCard,
};

async function runHealth(ctx) {
  const components = {};
  let healthy = true;
  for (const [name, fn] of Object.entries(CHECKS)) {
    try {
      await fn(ctx);
      components[name] = { status: 'ok' };
    } catch (e) {
      healthy = false;
      components[name] = { status: 'fail', error: e.message };
    }
  }
  return { status: healthy ? 'ok' : 'degraded', components, checkedAt: new Date().toISOString() };
}

module.exports = { runHealth };
