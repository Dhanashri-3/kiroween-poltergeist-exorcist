// Scenario_Engine: injection, reversal and reset (Task 4.3, Requirements 3.1-3.8).
//
//   inject(scenarioId, runId)  reject while an Incident is non-terminal (chaos.rejected Event); otherwise
//                              Snapshot ALL Approved_Files first, apply the scenario's deterministic
//                              replace_text transform to the scenario's own target files only, and record
//                              a chaos.injection Event (scenario, component, files, pre/post checksums,
//                              timestamp). If anything fails midway the Snapshot is restored and an
//                              error Event is recorded.
//   reverse(scenarioId)        applies the scenario's reversal transform (restores the previous bytes of
//                              the touched files if a write fails midway).
//   reset()                    restores the baseline Snapshot and records a reset Event.
//
// Every write goes through File_Guard (caller "scenario-engine"). Snapshot restores go through the shared
// Snapshot service. This module never imports or calls the Monitor, the Exorcist or the Incident_Manager;
// it only reads the `incidents` collection of the Storage interface to learn whether one is still open,
// and it writes only to the Event_Log. Scenario IDs are never passed to anything but the Event_Log.
import fs from 'node:fs';
import path from 'node:path';
import { resolveApprovedFile } from '../file-guard/path-safety.js';
import { sha256Hex } from '../file-guard/snapshots/snapshot-service.js';
import { SCENARIO_ENGINE_COMPONENT } from './catalog-loader.js';

export const SCENARIO_ENGINE_WRITE_CALLER = 'scenario-engine';
export const TERMINAL_INCIDENT_STATES = Object.freeze(['recovered', 'escalated']); // rolled_back is transient (Requirement 6.3)

export class ScenarioEngineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ScenarioEngineError';
    this.code = code;
    Object.assign(this, details);
  }
}

const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @param {object} options
 * @param {import('./catalog-loader.js').ScenarioCatalog} options.catalog
 * @param {string} options.testappDir
 * @param {{create: Function, restore: Function, list: Function, currentChecksums: Function}} options.snapshotService
 * @param {{assertWritable: Function}} options.fileGuard
 * @param {{append: Function}} options.eventLog
 * @param {{list: Function}} [options.storage] used to read the `incidents` collection
 * @param {() => Promise<boolean>|boolean} [options.hasNonTerminalIncident] overrides the storage lookup
 * @param {() => Date} [options.now]
 */
export function createScenarioEngine(options = {}) {
  const { catalog, testappDir, snapshotService, fileGuard, eventLog, storage, hasNonTerminalIncident, now = () => new Date() } = options;
  if (!catalog || typeof catalog.get !== 'function') throw new TypeError('catalog is required');
  if (typeof testappDir !== 'string' || testappDir === '') throw new TypeError('testappDir must be a non-empty string');
  for (const m of ['create', 'restore', 'list', 'currentChecksums']) {
    if (typeof snapshotService?.[m] !== 'function') throw new TypeError(`snapshotService.${m}() is required`);
  }
  if (typeof fileGuard?.assertWritable !== 'function') throw new TypeError('fileGuard.assertWritable is required');
  if (typeof eventLog?.append !== 'function') throw new TypeError('eventLog.append is required');
  if (typeof hasNonTerminalIncident !== 'function' && typeof storage?.list !== 'function') {
    throw new TypeError('storage.list or hasNonTerminalIncident is required to enforce the single-Incident rule');
  }

  const testappRoot = path.resolve(testappDir);
  let baselineSnapshotId = null;
  let queue = Promise.resolve(); // one operation at a time

  const serialize = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const stamp = () => new Date(now()).toISOString();

  async function record(event) {
    return eventLog.append({ component: SCENARIO_ENGINE_COMPONENT, ...event });
  }
  async function recordQuietly(event) {
    try {
      return await record(event);
    } catch {
      return null;
    }
  }

  async function incidentIsOpen() {
    if (typeof hasNonTerminalIncident === 'function') return Boolean(await hasNonTerminalIncident());
    const incidents = await storage.list('incidents');
    return incidents.some((i) => !TERMINAL_INCIDENT_STATES.includes(i?.state));
  }

  const absoluteOf = (rel) => path.join(testappRoot, ...rel.split('/'));

  function readText(rel) {
    const resolved = resolveApprovedFile(testappRoot, rel);
    if (!resolved.ok) throw new ScenarioEngineError('read_failed', `Cannot read ${rel}: ${resolved.code}.`);
    return fs.readFileSync(resolved.real, 'utf8');
  }

  const checksumsOf = (files) => files.map((rel) => ({ path: rel, checksum: sha256Hex(Buffer.from(readText(rel), 'utf8')) }));
  const rawChecksumsOf = (files) => {
    const byPath = new Map(snapshotService.currentChecksums().map((c) => [c.path, c.checksum]));
    return files.map((rel) => ({ path: rel, checksum: byPath.get(rel) }));
  };

  /**
   * Compute the new contents for a transform without writing anything.
   * Every step must stay inside `allowedFiles` and its `find` text must be present.
   * @returns {Map<string,{before:string, after:string}>} keyed by file, in first-use order
   */
  function planTransform(transform, allowedFiles) {
    const plan = new Map();
    for (const step of transform.steps) {
      if (!allowedFiles.includes(step.file)) {
        throw new ScenarioEngineError('file_not_designated', `Step targets a file outside the scenario's files: ${step.file}.`);
      }
      const current = plan.has(step.file) ? plan.get(step.file).after : readText(step.file);
      const at = current.indexOf(step.find);
      if (at === -1) throw new ScenarioEngineError('find_not_present', `Text to replace was not found in ${step.file}.`);
      const after = current.slice(0, at) + step.replace + current.slice(at + step.find.length);
      plan.set(step.file, { before: plan.has(step.file) ? plan.get(step.file).before : current, after });
    }
    return plan;
  }

  /** Guard every target first; nothing is written if any is denied. Returns [{file, real, ...}] */
  async function guardPlan(plan) {
    const guarded = [];
    for (const [file, change] of plan) {
      const decision = fileGuard.assertWritable(absoluteOf(file), SCENARIO_ENGINE_WRITE_CALLER);
      if (!decision.allowed) {
        if (decision.event) await recordQuietly({ ...decision.event, component: decision.event.component ?? 'file-guard' });
        throw new ScenarioEngineError('write_denied', `File_Guard denied the write: ${decision.code}.`, { denial: decision });
      }
      guarded.push({ file, real: decision.realPath, ...change });
    }
    return guarded;
  }

  const modifiedFiles = (plan) => [...plan.keys()];

  async function inject(scenarioId, runId) {
    return serialize(async () => {
      const scenario = catalog.get(scenarioId); // throws UnknownScenarioError: nothing changes (Requirement 2.5)
      const runRef = typeof runId === 'string' && runId !== '' ? runId : null;

      if (await incidentIsOpen()) {
        await record({
          type: 'chaos.rejected',
          runId: runRef,
          payload: { scenarioId, reason: 'incident_non_terminal', timestamp: stamp() },
        });
        throw new ScenarioEngineError('incident_active', 'An Incident is not yet in a terminal state; injection rejected.');
      }

      let snapshot;
      try {
        snapshot = await snapshotService.create('injection'); // before any file is modified (3.1)
      } catch (e) {
        await recordQuietly({
          type: 'error',
          runId: runRef,
          payload: { reason: 'injection_failed', stage: 'snapshot', scenarioId, message: messageOf(e), restored: false },
        });
        throw new ScenarioEngineError('snapshot_failed', `Injection aborted: snapshot failed (${messageOf(e)}).`, { cause: e });
      }

      const files = [...scenario.targetFiles];
      let pre;
      try {
        pre = rawChecksumsOf(files);
        const plan = planTransform(scenario.injection, files); // only the scenario's own files (3.2)
        const guarded = await guardPlan(plan);
        for (const g of guarded) fs.writeFileSync(g.real, g.after, 'utf8');
        const touched = modifiedFiles(plan);
        const post = rawChecksumsOf(touched);
        const timestamp = stamp();
        const event = await record({
          type: 'chaos.injection',
          runId: runRef,
          payload: {
            scenarioId,
            targetComponent: scenario.targetComponent,
            files: touched,
            preChecksums: pre.filter((c) => touched.includes(c.path)),
            postChecksums: post,
            snapshotId: snapshot.snapshotId,
            timestamp,
          },
        });
        return {
          scenarioId,
          runId: runRef,
          targetComponent: scenario.targetComponent,
          files: touched,
          preChecksums: event.payload.preChecksums,
          postChecksums: post,
          snapshotId: snapshot.snapshotId,
          timestamp,
          eventId: event.id,
        };
      } catch (e) {
        let restored = false;
        let restoreError = null;
        try {
          const result = await snapshotService.restore(snapshot.snapshotId);
          restored = result.matches === true;
          if (!restored) restoreError = `checksum mismatch after restore: ${result.mismatches.join(', ')}`;
        } catch (re) {
          restoreError = messageOf(re);
        }
        await recordQuietly({
          type: 'error',
          runId: runRef,
          payload: {
            reason: 'injection_failed',
            stage: 'apply',
            scenarioId,
            message: messageOf(e),
            snapshotId: snapshot.snapshotId,
            restored,
            ...(restoreError ? { restoreError } : {}),
          },
        });
        throw new ScenarioEngineError(
          'injection_failed',
          `Injection failed and ${restored ? 'the Snapshot was restored' : 'restoring the Snapshot also failed'}: ${messageOf(e)}`,
          { cause: e, restored, snapshotId: snapshot.snapshotId },
        );
      }
    });
  }

  async function reverse(scenarioId) {
    return serialize(async () => {
      const scenario = catalog.get(scenarioId);
      const files = [...scenario.targetFiles];
      const plan = planTransform(scenario.reversal, files);
      const guarded = await guardPlan(plan);
      const written = [];
      try {
        for (const g of guarded) {
          fs.writeFileSync(g.real, g.after, 'utf8');
          written.push(g);
        }
      } catch (e) {
        for (const g of written.reverse()) {
          try { fs.writeFileSync(g.real, g.before, 'utf8'); } catch { /* best effort */ }
        }
        throw new ScenarioEngineError('reversal_failed', `Reversal failed: ${messageOf(e)}`, { cause: e });
      }
      const touched = modifiedFiles(plan);
      return { scenarioId, files: touched, checksums: checksumsOf(touched) };
    });
  }

  /** Capture the baseline Snapshot of the pristine Test_App. Call once at startup before any injection. */
  async function captureBaseline() {
    return serialize(async () => {
      const snapshot = await snapshotService.create('baseline');
      baselineSnapshotId = snapshot.snapshotId;
      return snapshot;
    });
  }

  async function findBaselineId() {
    if (baselineSnapshotId) return baselineSnapshotId;
    const all = await snapshotService.list();
    const baselines = all.filter((s) => s.reason === 'baseline').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return baselines[0]?.snapshotId ?? null;
  }

  async function reset() {
    return serialize(async () => {
      const snapshotId = await findBaselineId();
      if (!snapshotId) {
        await recordQuietly({ type: 'error', payload: { reason: 'reset_failed', message: 'No baseline Snapshot exists.' } });
        throw new ScenarioEngineError('no_baseline', 'Reset impossible: no baseline Snapshot exists.');
      }
      let result;
      try {
        result = await snapshotService.restore(snapshotId);
      } catch (e) {
        await recordQuietly({ type: 'error', payload: { reason: 'reset_failed', snapshotId, message: messageOf(e) } });
        throw new ScenarioEngineError('reset_failed', `Reset failed: ${messageOf(e)}`, { cause: e });
      }
      if (!result.matches) {
        await recordQuietly({
          type: 'error',
          payload: { reason: 'reset_failed', snapshotId, message: `checksum mismatch after restore: ${result.mismatches.join(', ')}` },
        });
        throw new ScenarioEngineError('reset_failed', 'Reset failed: restored files do not match the baseline checksums.');
      }
      const timestamp = stamp();
      const event = await record({
        type: 'reset',
        payload: { snapshotId, files: result.restored.map((r) => r.path), checksums: result.restored, timestamp },
      });
      return { snapshotId, checksums: result.restored, timestamp, eventId: event.id };
    });
  }

  return Object.freeze({ inject, reverse, reset, captureBaseline });
}
