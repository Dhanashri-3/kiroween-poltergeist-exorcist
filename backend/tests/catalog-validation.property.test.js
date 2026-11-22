// Feature: poltergeist-exorcist-healing-system, Property 2: Catalog validation and unknown IDs
// **Validates: Requirements 2.4, 2.5**
//
// (a) The catalog loader accepts a catalog document only if it is well-formed, has unique scenario IDs and every
//     target file is an Approved_File; otherwise it throws CatalogLoadError.
// (b) For any scenario ID not in the loaded catalog, injection is rejected and no file or state changes.
// Runs the real loader, File_Guard, Snapshot service, store, Event_Log and Scenario_Engine on temp copies.
import { describe, it, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileGuard } from '../src/file-guard/file-guard.js';
import { createSnapshotService } from '../src/file-guard/snapshots/index.js';
import { createJsonStore } from '../src/storage/index.js';
import { createEventLog } from '../src/events/event-log.js';
import {
  loadScenarioCatalog,
  createScenarioEngine,
  CatalogLoadError,
  UnknownScenarioError,
} from '../src/scenario-engine/index.js';
import { DEFAULT_CONFIG_DIR, DEFAULT_TESTAPP_DIR } from '../src/orchestrator/config-loader.js';

const temps = [];
afterAll(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

const baseDoc = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONFIG_DIR, 'scenario-catalog.json'), 'utf8'));
const approvedFiles = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONFIG_DIR, 'approved-files.json'), 'utf8')).files;
const N = baseDoc.scenarios.length;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-prop-'));
temps.push(root);
const configDir = path.join(root, 'config');
const testappDir = path.join(root, 'testapp');
fs.cpSync(DEFAULT_CONFIG_DIR, configDir, { recursive: true });
fs.cpSync(DEFAULT_TESTAPP_DIR, testappDir, { recursive: true, filter: (s) => !s.includes('node_modules') });

const catalogFile = path.join(configDir, 'scenario-catalog.json');
const clone = () => JSON.parse(JSON.stringify(baseDoc));
const tryLoad = async (doc) => {
  fs.writeFileSync(catalogFile, JSON.stringify(doc, null, 2));
  return loadScenarioCatalog({ configDir, testappDir }).then((c) => ({ ok: true, catalog: c }), (e) => ({ ok: false, error: e }));
};

// Documents that must be refused.
const invalidDocArb = fc.oneof(
  // duplicate scenario ID
  fc.tuple(fc.integer({ min: 0, max: N - 1 }), fc.integer({ min: 1, max: N - 1 })).map(([i, d]) => {
    const doc = clone();
    doc.scenarios[i].scenarioId = doc.scenarios[(i + d) % N].scenarioId;
    return doc;
  }),
  // target file that is not an Approved_File
  fc.tuple(
    fc.integer({ min: 0, max: N - 1 }),
    fc.string({ unit: fc.constantFrom(...'abcdefghijklmnop-_/.'), minLength: 1, maxLength: 20 }).filter((s) => !approvedFiles.includes(s)),
  ).map(([i, file]) => {
    const doc = clone();
    doc.scenarios[i].targetFiles = [...doc.scenarios[i].targetFiles, file];
    return doc;
  }),
  // malformed: required field removed or of the wrong type
  fc.tuple(
    fc.integer({ min: 0, max: N - 1 }),
    fc.constantFrom('scenarioId', 'targetComponent', 'targetFiles', 'injection', 'reversal', 'severity', 'expectedRepairAction'),
    fc.constantFrom('delete', 'number', 'null'),
  ).map(([i, field, how]) => {
    const doc = clone();
    if (how === 'delete') delete doc.scenarios[i][field];
    else doc.scenarios[i][field] = how === 'number' ? 42 : null;
    return doc;
  }),
  // scenarios is not an array
  fc.constantFrom({ ...clone(), scenarios: {} }, { ...clone(), scenarios: 'x' }, { version: baseDoc.version }),
);

describe('Property 2: Catalog validation and unknown IDs', () => {
  it('refuses every catalog that is malformed, has duplicate IDs or targets a non-approved file', async () => {
    await fc.assert(
      fc.asyncProperty(invalidDocArb, async (doc) => {
        const res = await tryLoad(doc);
        expect(res.ok).toBe(false);
        expect(res.error).toBeInstanceOf(CatalogLoadError);
        expect(res.error.errors.length).toBeGreaterThan(0);
      }),
      { numRuns: 60 },
    );
  }, 120000);

  it('accepts well-formed catalogs with unique IDs and approved targets (any order)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray(baseDoc.scenarios, { minLength: N, maxLength: N }), async (scenarios) => {
        const res = await tryLoad({ ...clone(), scenarios: JSON.parse(JSON.stringify(scenarios)) });
        expect(res.ok).toBe(true);
        expect([...res.catalog.ids].sort()).toEqual(baseDoc.scenarios.map((s) => s.scenarioId).sort());
      }),
      { numRuns: 20 },
    );
  }, 60000);

  it('rejects injection of any ID not in the catalog without changing files or state', async () => {
    fs.writeFileSync(catalogFile, JSON.stringify(baseDoc, null, 2));
    const catalog = await loadScenarioCatalog({ configDir, testappDir });
    const storageDir = path.join(root, 'storage-data');
    fs.mkdirSync(storageDir, { recursive: true });
    const fileGuard = createFileGuard({ testappDir, approvedFiles, storageDirs: [storageDir] });
    const storage = createJsonStore({ directory: storageDir });
    const snapshotService = createSnapshotService({ testappDir, approvedFiles, storageDir, storage, fileGuard });
    const eventLog = createEventLog({ storage });
    const engine = createScenarioEngine({ catalog, testappDir, snapshotService, fileGuard, eventLog, storage });

    const unknownIdArb = fc.oneof(
      fc.string({ maxLength: 30 }),
      fc.constantFrom('', '__proto__', 'constructor', 'toString', 'Button-Failure', ' button-failure'),
      fc.constant(undefined),
      fc.constant(null),
      fc.integer(),
    ).filter((id) => !(typeof id === 'string' && catalog.ids.includes(id)));

    const state = async () => ({
      checksums: snapshotService.currentChecksums(),
      snapshots: await snapshotService.list(),
      events: await storage.list('events'),
      incidents: await storage.list('incidents'),
    });
    const before = await state();

    await fc.assert(
      fc.asyncProperty(unknownIdArb, async (id) => {
        await expect(engine.inject(id, 'run-prop')).rejects.toBeInstanceOf(UnknownScenarioError);
        expect(await state()).toEqual(before);
      }),
      { numRuns: 100 },
    );
  }, 120000);
});
