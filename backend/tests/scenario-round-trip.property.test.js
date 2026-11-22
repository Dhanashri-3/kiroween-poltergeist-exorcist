// Feature: poltergeist-exorcist-healing-system, Property 1: Scenario injection round trip
// **Validates: Requirements 2.6**
//
// For any Scenario in the Scenario_Catalog (and any baseline Approved_File set), injecting the Scenario then
// applying its reversal restores every affected Approved_File to a checksum identical to its baseline.
// Runs against a temp copy of the Test_App with the real File_Guard, Snapshot service, store and Event_Log.
import { describe, it, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileGuard } from '../src/file-guard/file-guard.js';
import { createSnapshotService } from '../src/file-guard/snapshots/index.js';
import { createJsonStore } from '../src/storage/index.js';
import { createEventLog } from '../src/events/event-log.js';
import { loadScenarioCatalog, createScenarioEngine } from '../src/scenario-engine/index.js';
import { DEFAULT_CONFIG_DIR, DEFAULT_TESTAPP_DIR } from '../src/orchestrator/config-loader.js';

const temps = [];
afterAll(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

const catalog = await loadScenarioCatalog();
const approvedFiles = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONFIG_DIR, 'approved-files.json'), 'utf8')).files;

// Varies the baseline: harmless trailing text appended to each Approved_File of the temp copy.
const suffixArb = fc.string({ unit: fc.constantFrom(...'abcdefghij 0123456789\n'), maxLength: 40 });
const baselineArb = fc.array(suffixArb, { minLength: approvedFiles.length, maxLength: approvedFiles.length });

async function setup(suffixes) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roundtrip-')));
  temps.push(base);
  const testappDir = path.join(base, 'testapp');
  const storageDir = path.join(base, 'storage-data');
  fs.cpSync(DEFAULT_TESTAPP_DIR, testappDir, { recursive: true, filter: (s) => !s.includes('node_modules') });
  fs.mkdirSync(storageDir, { recursive: true });
  approvedFiles.forEach((rel, i) => {
    if (suffixes[i]) fs.appendFileSync(path.join(testappDir, ...rel.split('/')), suffixes[i], 'utf8');
  });
  const fileGuard = createFileGuard({ testappDir, approvedFiles, storageDirs: [storageDir] });
  const storage = createJsonStore({ directory: storageDir });
  const snapshotService = createSnapshotService({ testappDir, approvedFiles, storageDir, storage, fileGuard });
  const eventLog = createEventLog({ storage });
  const engine = createScenarioEngine({ catalog, testappDir, snapshotService, fileGuard, eventLog, storage });
  return { engine, snapshotService };
}

describe('Property 1: Scenario injection round trip', () => {
  it('inject then reverse restores every Approved_File to its baseline checksum', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...catalog.ids), baselineArb, async (scenarioId, suffixes) => {
        const { engine, snapshotService } = await setup(suffixes);
        const baseline = snapshotService.currentChecksums();

        const rec = await engine.inject(scenarioId, 'run-prop');
        const injected = snapshotService.currentChecksums();
        // the injection really changed the touched files
        for (const f of rec.files) {
          expect(injected.find((c) => c.path === f).checksum).not.toBe(baseline.find((c) => c.path === f).checksum);
        }

        await engine.reverse(scenarioId);
        expect(snapshotService.currentChecksums()).toEqual(baseline);
      }),
      { numRuns: 30 },
    );
  }, 120000);
});
