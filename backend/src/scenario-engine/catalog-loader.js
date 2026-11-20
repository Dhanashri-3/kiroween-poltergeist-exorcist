// Scenario catalog loader (Task 4.2, Requirements 2.1-2.5).
// Loads the versioned Scenario_Catalog at startup through the shared configuration loader, which
// validates the schema, unique scenario IDs, the six required scenarios and that every target
// file is an Approved_File. On any problem it records one error Event per problem, naming the
// invalid entry, and throws CatalogLoadError so the caller refuses to start. Scenario lookups
// reject IDs that are not in the validated catalog.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, DEFAULT_CONFIG_DIR, DEFAULT_TESTAPP_DIR, CONFIG_FILES } from '../orchestrator/config-loader.js';

export const SCENARIO_ENGINE_COMPONENT = 'scenario-engine';

export class CatalogLoadError extends Error {
  constructor(errors) {
    super(`Scenario catalog refused: ${errors.length} problem(s). First: ${errors[0]?.message ?? 'unknown'}`);
    this.name = 'CatalogLoadError';
    this.code = 'catalog_invalid';
    this.errors = errors;
  }
}

export class UnknownScenarioError extends Error {
  constructor(scenarioId) {
    super(`Unknown scenario ID: ${JSON.stringify(scenarioId)}`);
    this.name = 'UnknownScenarioError';
    this.code = 'unknown_scenario';
    this.scenarioId = scenarioId;
  }
}

/** Best-effort read of the raw catalog, used only to name the invalid entry in error Events. */
function readRawScenarios(configDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(configDir, CONFIG_FILES.scenarioCatalog), 'utf8'));
    return Array.isArray(doc?.scenarios) ? doc.scenarios : [];
  } catch {
    return [];
  }
}

/** Describe the catalog entry an error refers to: { index, scenarioId } (fields null if unknown). */
function entryOf(error, rawScenarios) {
  if (error.file !== CONFIG_FILES.scenarioCatalog) return null;
  let index = null;
  let scenarioId = null;
  const byPath = /^\/scenarios\/(\d+)(?:\/|$)/.exec(error.path ?? '');
  const byText = /scenario #(\d+) \(([^)]*)\)/.exec(error.message ?? '');
  if (byPath) index = Number(byPath[1]);
  else if (byText) { index = Number(byText[1]); scenarioId = byText[2]; }
  if (index !== null && scenarioId === null) {
    const raw = rawScenarios[index];
    scenarioId = typeof raw?.scenarioId === 'string' ? raw.scenarioId : null;
  }
  if (scenarioId === null) {
    const byId = /(?:scenario ID|scenario|Required scenario) ([a-z][a-z-]*)/.exec(error.message ?? '');
    if (byId) scenarioId = byId[1];
  }
  return index === null && scenarioId === null ? null : { index, scenarioId };
}

/** Immutable, validated catalog with ID lookups that reject unknown scenarios. */
export class ScenarioCatalog {
  constructor(scenarios, version) {
    this.version = version;
    this._byId = new Map(scenarios.map((s) => [s.scenarioId, s]));
    this.scenarios = Object.freeze([...scenarios]);
    Object.freeze(this);
  }

  get ids() { return this.scenarios.map((s) => s.scenarioId); }

  has(scenarioId) {
    return typeof scenarioId === 'string' && this._byId.has(scenarioId);
  }

  /** Returns the scenario or throws UnknownScenarioError (Requirement 2.5). */
  get(scenarioId) {
    if (!this.has(scenarioId)) throw new UnknownScenarioError(scenarioId);
    return this._byId.get(scenarioId);
  }
}

/**
 * Load and validate the catalog.
 * @param {{configDir?: string, testappDir?: string, eventLog?: {append: Function}}} [options]
 * @returns {Promise<ScenarioCatalog>} resolves with the catalog, or rejects with CatalogLoadError.
 */
export async function loadScenarioCatalog({ configDir = DEFAULT_CONFIG_DIR, testappDir = DEFAULT_TESTAPP_DIR, eventLog } = {}) {
  const result = loadConfig({ configDir, testappDir });
  if (result.ok) return new ScenarioCatalog(result.config.scenarioCatalog, result.config.versions.scenarioCatalog);

  const raw = readRawScenarios(configDir);
  const errors = result.errors.map((e) => ({ ...e, entry: entryOf(e, raw) }));
  if (eventLog) {
    for (const e of errors) {
      const named = e.entry?.scenarioId ? ` [entry: ${e.entry.scenarioId}]` : '';
      try {
        await eventLog.append({
          type: 'error',
          component: SCENARIO_ENGINE_COMPONENT,
          payload: {
            reason: 'catalog_invalid',
            file: e.file,
            code: e.code,
            message: `${e.message}${named}`,
            entry: e.entry,
          },
        });
      } catch {
        // Recording is best effort; startup is refused either way.
      }
    }
  }
  throw new CatalogLoadError(errors);
}
