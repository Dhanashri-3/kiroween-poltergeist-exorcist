// Task 4.2: Scenario catalog loader (Requirements 2.1-2.5).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadScenarioCatalog, CatalogLoadError, UnknownScenarioError } from '../src/scenario-engine/index.js';
import { createEventLog } from '../src/events/event-log.js';
import { DEFAULT_CONFIG_DIR, DEFAULT_TESTAPP_DIR, REQUIRED_SCENARIO_IDS } from '../src/orchestrator/config-loader.js';

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  tmpDirs.push(root);
  const configDir = path.join(root, 'config');
  const testappDir = path.join(root, 'testapp');
  fs.cpSync(DEFAULT_CONFIG_DIR, configDir, { recursive: true });
  fs.cpSync(DEFAULT_TESTAPP_DIR, testappDir, { recursive: true, filter: (src) => !src.includes('node_modules') });
  const file = path.join(configDir, 'scenario-catalog.json');
  const edit = (fn) => { const d = JSON.parse(fs.readFileSync(file, 'utf8')); fn(d); fs.writeFileSync(file, JSON.stringify(d, null, 2)); };
  return { configDir, testappDir, edit };
}

function memoryLog() {
  const rows = [];
  const storage = {
    append: async (_c, e) => { rows.push(e); },
    list: async () => [...rows],
  };
  return { log: createEventLog({ storage }), rows };
}

describe('shipped scenario catalog', () => {
  it('has exactly the six required scenarios with all required fields', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONFIG_DIR, 'scenario-catalog.json'), 'utf8'));
    expect(doc.version).toEqual(expect.any(String));
    expect(doc.scenarios.map((s) => s.scenarioId).sort()).toEqual([...REQUIRED_SCENARIO_IDS].sort());
    expect(doc.scenarios).toHaveLength(6);
    for (const s of doc.scenarios) {
      expect(s.scenarioId).toEqual(expect.any(String));
      expect(['button', 'layout', 'dataPanel', 'card']).toContain(s.targetComponent);
      expect(s.injection?.steps?.length).toBeGreaterThan(0);
      expect(s.reversal?.steps?.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high', 'critical']).toContain(s.severity);
      expect(s.expectedRepairAction?.actionType).toEqual(expect.any(String));
    }
  });

  it('loads through the loader and exposes lookups', async () => {
    const catalog = await loadScenarioCatalog();
    expect(catalog.ids).toHaveLength(6);
    expect(catalog.version).toEqual(expect.any(String));
    expect(catalog.get('api-failure').targetComponent).toBe('dataPanel');
    expect(catalog.has('button-failure')).toBe(true);
  });

  it('rejects unknown scenario IDs', async () => {
    const catalog = await loadScenarioCatalog();
    for (const id of ['nope', '', undefined, null, 42, '__proto__', 'constructor']) {
      expect(catalog.has(id)).toBe(false);
      expect(() => catalog.get(id)).toThrow(UnknownScenarioError);
    }
  });
});

describe('catalog load failures', () => {
  it('refuses a target file that is not an Approved_File and records an error Event naming the entry', async () => {
    const fx = fixture();
    fx.edit((d) => { d.scenarios[2].targetFiles = ['server.js']; });
    const { log, rows } = memoryLog();
    const err = await loadScenarioCatalog({ ...fx, eventLog: log }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CatalogLoadError);
    expect(rows.length).toBeGreaterThan(0);
    const named = rows.find((e) => e.payload.entry?.scenarioId === 'component-disappearance');
    expect(named).toBeDefined();
    expect(named.type).toBe('error');
    expect(named.component).toBe('scenario-engine');
    expect(named.payload.code).toBe('not_approved');
    expect(named.payload.message).toContain('component-disappearance');
  });

  it('refuses duplicate scenario IDs', async () => {
    const fx = fixture();
    fx.edit((d) => { d.scenarios[1].scenarioId = 'button-failure'; });
    const { log, rows } = memoryLog();
    await expect(loadScenarioCatalog({ ...fx, eventLog: log })).rejects.toBeInstanceOf(CatalogLoadError);
    expect(rows.some((e) => e.payload.code === 'duplicate' && e.payload.message.includes('button-failure'))).toBe(true);
  });

  it('refuses a schema-invalid entry and names it by index and ID', async () => {
    const fx = fixture();
    fx.edit((d) => { d.scenarios[3].severity = 'catastrophic'; });
    const { log, rows } = memoryLog();
    await expect(loadScenarioCatalog({ ...fx, eventLog: log })).rejects.toBeInstanceOf(CatalogLoadError);
    const e = rows.find((r) => r.payload.code === 'schema_invalid');
    expect(e.payload.entry).toEqual({ index: 3, scenarioId: 'api-failure' });
  });

  it('refuses an unknown scenario ID in the catalog', async () => {
    const fx = fixture();
    fx.edit((d) => { d.scenarios[0].scenarioId = 'mystery-failure'; });
    const { log, rows } = memoryLog();
    await expect(loadScenarioCatalog({ ...fx, eventLog: log })).rejects.toBeInstanceOf(CatalogLoadError);
    expect(rows.some((e) => e.payload.code === 'unknown_scenario' && e.payload.entry?.scenarioId === 'mystery-failure')).toBe(true);
  });

  it('refuses when the catalog file is missing, even without an Event_Log', async () => {
    const fx = fixture();
    fs.rmSync(path.join(fx.configDir, 'scenario-catalog.json'));
    const err = await loadScenarioCatalog(fx).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CatalogLoadError);
    expect(err.errors[0].code).toBe('missing_file');
  });
});
