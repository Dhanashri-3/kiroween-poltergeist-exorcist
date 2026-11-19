// Configuration loader (Task 2.2).
// Loads the five approved configuration files, validates each complete document against its
// contract schema and runs cross-file safety checks. Any problem produces structured errors and
// initialization is refused. There are no silent defaults: a missing or invalid file is never
// replaced.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validate } from '../contracts/index.js';
import { COMPONENT_IDS as CONTRACT_COMPONENT_IDS } from '../contracts/common.js';
import {
  checkRelativePathSyntax,
  checkSensitiveFile,
  resolveApprovedFile,
  actionFileCompatible,
} from '../file-guard/path-safety.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_DIR = path.resolve(HERE, '..', '..', 'config');
export const DEFAULT_TESTAPP_DIR = path.resolve(HERE, '..', '..', '..', 'testapp');

export const CONFIG_FILES = Object.freeze({
  approvedFiles: 'approved-files.json',
  actionAllowlist: 'action-allowlist.json',
  scenarioCatalog: 'scenario-catalog.json',
  commandTemplates: 'command-templates.json',
  fallbackMapping: 'fallback-mapping.json',
});

/** Fixed component identifiers (the Test_App health check names). */
export const COMPONENT_IDS = Object.freeze([...CONTRACT_COMPONENT_IDS]);
export const REQUIRED_SCENARIO_IDS = Object.freeze([
  'button-failure',
  'layout-corruption',
  'component-disappearance',
  'api-failure',
  'styling-failure',
  'loading-failure',
]);
export const ACTION_TYPES = Object.freeze(['replace_text', 'replace_style_rule', 'replace_mock_api_handler']);
export const REQUIRED_TEMPLATE_IDS = Object.freeze(['Health_Check', 'Vitest', 'Playwright']);
const MAX_CHANGED_LINES_CAP = 50; // Safety_Gate rule R5

// ---------------------------------------------------------------------------------------------
// Pinned command templates (Requirement 16.10 / Property 33).
// A template is accepted only if it equals its pinned entry exactly: same executable, same full
// args array (strict, ordered equality), same allowedParams enum and a timeout at or below the cap.
// There is no denylist: any other script text, script path, extra/missing/reordered argument or
// Node option makes the arguments differ from the pin and is rejected as unsafe_command.

/**
 * Health_Check script, run as `node -e <script> [component]`. It fails closed: every problem
 * (network, HTTP status, JSON, missing/unknown/unhealthy component, overall status) is a non-zero
 * exit with the reason on stderr. The URL is fixed and the only input is process.argv[1].
 */
export const HEALTH_CHECK_SCRIPT =
  "const A=['button','layout','dataPanel','card'];const c=process.argv[1];" +
  "const die=(m,k)=>{console.error(m);process.exit(k||1)};" +
  "const isO=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);" +
  "(async()=>{if(c!==undefined&&!A.includes(c))return die('unknown component: '+c);" +
  "const r=await fetch('http://127.0.0.1:4100/health',{signal:AbortSignal.timeout(5000)});" +
  "if(r.status!==200||r.ok!==true)return die('HTTP status '+r.status);" +
  "const b=await r.json();if(!isO(b))return die('invalid body');" +
  "if(b.status!==undefined&&b.status!=='ok')return die('overall status is '+String(b.status));" +
  "const m=b.components;if(!isO(m))return die('components missing');" +
  "for(const k of A)if(!Object.hasOwn(m,k))return die('component missing: '+k);" +
  "const t=c===undefined?A:[c];const bad=t.filter(k=>!isO(m[k])||m[k].status!=='ok');" +
  "if(bad.length)return die('unhealthy: '+bad.join(','));console.log('ok')})()" +
  ".catch(e=>die(String(e&&e.message||e),2))";

/** SHA-256 of HEALTH_CHECK_SCRIPT, pinned as a literal so an edit to the constant is also caught. */
export const HEALTH_CHECK_SCRIPT_SHA256 = '1133bf43b681ef9a23ea23c916619a0a8b3607a295062622846350d6ce65fe1d';

const PINNED_PARAMS = Object.freeze([...COMPONENT_IDS]);
export const PINNED_COMMAND_TEMPLATES = Object.freeze({
  Health_Check: Object.freeze({
    executable: 'node',
    args: Object.freeze(['-e', HEALTH_CHECK_SCRIPT]),
    allowedParams: PINNED_PARAMS,
    maxTimeoutMs: 10000,
  }),
  Vitest: Object.freeze({
    executable: 'node',
    args: Object.freeze(['backend/node_modules/vitest/vitest.mjs', 'run', '--root', 'testapp']),
    allowedParams: PINNED_PARAMS,
    maxTimeoutMs: 60000,
  }),
  Playwright: Object.freeze({
    executable: 'node',
    args: Object.freeze(['testapp/node_modules/@playwright/test/cli.js', 'test', '--config', 'testapp/playwright.config.js']),
    allowedParams: PINNED_PARAMS,
    maxTimeoutMs: 90000,
  }),
});

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const sameArray = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

export class ConfigError extends Error {
  constructor(errors) {
    super(`Configuration refused: ${errors.length} problem(s). First: ${errors[0]?.message ?? 'unknown'}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return count;
    count += 1;
    from = i + needle.length;
  }
}

/** Replace the single occurrence of `find`; returns null unless it occurs exactly once. */
function replaceOnce(content, find, replace) {
  if (countOccurrences(content, find) !== 1) return null;
  const i = content.indexOf(find);
  return content.slice(0, i) + replace + content.slice(i + find.length);
}

/**
 * Changed-line rule for a {find, replace} change: max(lines in find, lines in replace), where an
 * empty string has 0 lines and otherwise lines = number of "\n"-separated parts. The larger side
 * bounds how many lines of the file can differ after one replacement.
 */
export function changedLines(change) {
  const lines = (s) => (s === '' ? 0 : s.split('\n').length);
  return Math.max(lines(change.find), lines(change.replace));
}

class Collector {
  constructor() { this.errors = []; }
  add(file, code, message, extra = {}) { this.errors.push({ file, code, message, ...extra }); }
  get count() { return this.errors.length; }
}

function readJson(configDir, fileName, out) {
  const full = path.join(configDir, fileName);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') out.add(fileName, 'missing_file', `Configuration file is missing: ${fileName}`);
    else out.add(fileName, 'unreadable_file', `Configuration file cannot be read: ${fileName} (${err?.code ?? 'error'})`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    out.add(fileName, 'malformed_json', `Malformed JSON in ${fileName}: ${err.message}`);
    return undefined;
  }
}

function schemaErrors(out, file, schemaName, value, label) {
  const result = validate(schemaName, value);
  if (result.valid) return true;
  for (const e of result.errors) {
    out.add(file, 'schema_invalid', `${label}: ${e.path} ${e.message}`, { path: e.path, keyword: e.keyword });
  }
  return false;
}

/** Shared check of a {find, replace} change against the allowlist entry's maxChangedLines. */
function checkChangeSize(out, file, where, change, allowEntry) {
  const n = changedLines(change);
  if (allowEntry && n > allowEntry.maxChangedLines) {
    out.add(file, 'unsafe_limit', `${where}: change touches ${n} lines, above maxChangedLines ${allowEntry.maxChangedLines} for ${allowEntry.actionType}.`);
  }
}

// ---------------------------------------------------------------- approved-files
function checkApprovedFiles(doc, testappDir, out, baseline) {
  const file = CONFIG_FILES.approvedFiles;
  if (!schemaErrors(out, file, 'ApprovedFilesDocument', doc, 'Approved_Files')) return undefined;
  const seen = new Set();
  const approved = [];
  for (const [index, entry] of doc.files.entries()) {
    const at = { path: `/files/${index}` };
    const syntax = checkRelativePathSyntax(entry);
    if (!syntax.ok) {
      out.add(file, 'unsafe_path', `Approved file #${index} ${JSON.stringify(entry)} rejected: ${syntax.message}`, { ...at, reason: syntax.code });
      continue;
    }
    const sensitive = checkSensitiveFile(entry);
    if (!sensitive.ok) {
      out.add(file, 'sensitive_file', `Approved file #${index} ${JSON.stringify(entry)} rejected: ${sensitive.message}`, { ...at, reason: sensitive.code });
      continue;
    }
    // Case-insensitive on every platform, and decided before touching the file system, so
    // "Mock-API.js" and "mock-api.js" are duplicates even where they would be distinct files.
    const key = entry.toLowerCase();
    if (seen.has(key)) {
      out.add(file, 'duplicate', `Duplicate approved file (case-insensitive): ${entry}`, at);
      continue;
    }
    seen.add(key);
    const resolved = resolveApprovedFile(testappDir, entry);
    if (!resolved.ok) {
      const missing = ['not_found', 'root_missing', 'root_not_directory'].includes(resolved.code);
      out.add(file, missing ? 'file_not_found' : 'unsafe_path', `Approved file #${index} ${JSON.stringify(entry)} rejected: ${resolved.message}`, { ...at, reason: resolved.code });
      continue;
    }
    approved.push(entry);
    baseline.set(entry, fs.readFileSync(resolved.real, 'utf8'));
  }
  return approved;
}

// ---------------------------------------------------------------- action allowlist
function checkAllowlist(doc, approved, out) {
  const file = CONFIG_FILES.actionAllowlist;
  if (!schemaErrors(out, file, 'ActionAllowlist', doc, 'Action_Allowlist')) return undefined;
  const approvedSet = approved ? new Set(approved) : null;
  const types = new Set();
  doc.forEach((entry, i) => {
    if (!ACTION_TYPES.includes(entry.actionType)) {
      out.add(file, 'unknown_action_type', `Action type ${JSON.stringify(entry.actionType)} is not an approved action type.`, { path: `/${i}/actionType` });
    }
    if (types.has(entry.actionType)) out.add(file, 'duplicate', `Duplicate action type ${entry.actionType}.`, { path: `/${i}` });
    types.add(entry.actionType);
    if (entry.maxChangedLines > MAX_CHANGED_LINES_CAP) {
      out.add(file, 'unsafe_limit', `maxChangedLines ${entry.maxChangedLines} exceeds the cap of ${MAX_CHANGED_LINES_CAP}.`, { path: `/${i}/maxChangedLines` });
    }
    entry.allowedFiles.forEach((f, j) => {
      if (approvedSet && !approvedSet.has(f)) {
        out.add(file, 'not_approved', `Allowed file ${JSON.stringify(f)} is not in approved-files.json.`, { path: `/${i}/allowedFiles/${j}` });
      }
      if (ACTION_TYPES.includes(entry.actionType) && !actionFileCompatible(entry.actionType, f)) {
        out.add(file, 'unsafe_action_file', `Allowed file ${JSON.stringify(f)} is not valid for ${entry.actionType}.`, { path: `/${i}/allowedFiles/${j}` });
      }
    });
  });
  for (const t of ACTION_TYPES) {
    if (!types.has(t)) out.add(file, 'missing_action_type', `Required action type ${t} is missing.`);
  }
  return doc;
}

// ---------------------------------------------------------------- scenario catalog
function applySteps(state, steps) {
  const next = new Map(state);
  for (const step of steps) {
    const before = next.get(step.file);
    if (before === undefined) return { error: `file ${step.file} has no baseline content` };
    const count = countOccurrences(before, step.find);
    if (count !== 1) return { error: `find text ${JSON.stringify(step.find)} occurs ${count} times in ${step.file} (must be exactly 1)` };
    next.set(step.file, replaceOnce(before, step.find, step.replace));
  }
  return { state: next };
}

/** Semantic checks of the transform steps that the schema cannot express. */
function checkTransformSteps(out, file, where, transform, targetFiles) {
  let ok = true;
  for (const [k, step] of transform.steps.entries()) {
    if (step.find === step.replace) {
      out.add(file, 'invalid_transform', `${where} step ${k}: replace must differ from find.`);
      ok = false;
    } else if (!targetFiles.includes(step.file)) {
      out.add(file, 'not_approved', `${where} step ${k} touches ${JSON.stringify(step.file)}, which is not one of the scenario's targetFiles.`);
      ok = false;
    }
  }
  return ok;
}

/** Returns the validated scenarios and, per scenario, its injected in-memory state. */
function checkScenarioCatalog(doc, approved, allowlist, baseline, out) {
  const file = CONFIG_FILES.scenarioCatalog;
  if (!schemaErrors(out, file, 'ScenarioCatalogDocument', doc, 'Scenario_Catalog')) return undefined;
  if (!approved) return undefined; // targets cannot be judged without Approved_Files
  const approvedSet = new Set(approved);
  const ids = new Set();
  const injected = new Map();
  doc.scenarios.forEach((s, i) => {
    const where = `scenario #${i} (${s.scenarioId})`;
    if (ids.has(s.scenarioId)) out.add(file, 'duplicate', `Duplicate scenario ID ${s.scenarioId}.`, { path: `/scenarios/${i}/scenarioId` });
    ids.add(s.scenarioId);
    if (!REQUIRED_SCENARIO_IDS.includes(s.scenarioId)) {
      out.add(file, 'unknown_scenario', `${where}: scenario ID is not one of the six approved scenarios.`);
    }
    let targetsOk = true;
    for (const f of s.targetFiles) {
      if (!approvedSet.has(f)) {
        targetsOk = false;
        out.add(file, 'not_approved', `${where}: target file ${JSON.stringify(f)} is not an Approved_File.`);
      }
    }
    if (!targetsOk) return;

    const injectOk = checkTransformSteps(out, file, `${where} injection`, s.injection, s.targetFiles);
    const reverseOk = checkTransformSteps(out, file, `${where} reversal`, s.reversal, s.targetFiles);
    if (!injectOk || !reverseOk) return;

    const afterInject = applySteps(baseline, s.injection.steps);
    if (afterInject.error) {
      out.add(file, 'transform_mismatch', `${where} injection does not match the Test_App files: ${afterInject.error}.`);
      return;
    }
    const changed = s.targetFiles.some((f) => afterInject.state.get(f) !== baseline.get(f));
    if (!changed) out.add(file, 'transform_mismatch', `${where} injection does not change any file.`);
    for (const [f, content] of afterInject.state) {
      if (content !== baseline.get(f) && !s.targetFiles.includes(f)) {
        out.add(file, 'transform_mismatch', `${where} injection modifies ${f}, which is not in targetFiles.`);
      }
    }
    const afterReverse = applySteps(afterInject.state, s.reversal.steps);
    if (afterReverse.error) {
      out.add(file, 'transform_mismatch', `${where} reversal does not match the injected files: ${afterReverse.error}.`);
      return;
    }
    for (const [f, content] of baseline) {
      if (afterReverse.state.get(f) !== content) {
        out.add(file, 'transform_mismatch', `${where} reversal does not restore ${f} to its baseline content.`);
      }
    }
    injected.set(s.scenarioId, afterInject.state);

    // expectedRepairAction must be an allowlisted, compatible, size-bounded action on a target file.
    const action = s.expectedRepairAction;
    const entry = allowlist?.find((a) => a.actionType === action.actionType);
    if (allowlist && !entry) out.add(file, 'not_allowlisted', `${where} expectedRepairAction type ${action.actionType} is not in the Action_Allowlist.`);
    else if (entry && !entry.allowedFiles.includes(action.targetFile)) out.add(file, 'not_allowlisted', `${where} expectedRepairAction target ${action.targetFile} is not allowed for ${action.actionType}.`);
    if (!actionFileCompatible(action.actionType, action.targetFile)) {
      out.add(file, 'unsafe_action_file', `${where} expectedRepairAction ${action.actionType} cannot target ${JSON.stringify(action.targetFile)}.`);
    }
    if (!s.targetFiles.includes(action.targetFile)) out.add(file, 'invalid_repair_action', `${where} expectedRepairAction target is not in targetFiles.`);
    checkChangeSize(out, file, `${where} expectedRepairAction`, action.change, entry);
    const fixed = replaceOnce(afterInject.state.get(action.targetFile) ?? '', action.change.find, action.change.replace);
    if (fixed !== baseline.get(action.targetFile)) {
      out.add(file, 'invalid_repair_action', `${where} expectedRepairAction does not restore the baseline content of ${action.targetFile}.`);
    }
  });
  for (const id of REQUIRED_SCENARIO_IDS) {
    if (!ids.has(id)) out.add(file, 'missing_scenario', `Required scenario ${id} is missing.`);
  }
  return { scenarios: doc.scenarios, injected };
}

// ---------------------------------------------------------------- command templates
function checkCommandTemplates(doc, out) {
  const file = CONFIG_FILES.commandTemplates;
  if (!schemaErrors(out, file, 'CommandTemplatesDocument', doc, 'Command templates')) return undefined;
  if (sha256(HEALTH_CHECK_SCRIPT) !== HEALTH_CHECK_SCRIPT_SHA256) {
    out.add(file, 'unsafe_command', 'Pinned Health_Check script does not match its pinned SHA-256 (loader constant was altered).');
  }
  const ids = new Set();
  doc.templates.forEach((t, i) => {
    const where = `template #${i} (${t.templateId})`;
    const pin = Object.hasOwn(PINNED_COMMAND_TEMPLATES, t.templateId) ? PINNED_COMMAND_TEMPLATES[t.templateId] : undefined;
    if (!pin) {
      out.add(file, 'unknown_template', `${where}: templateId must be one of ${REQUIRED_TEMPLATE_IDS.join(', ')}.`);
      return;
    }
    if (ids.has(t.templateId)) out.add(file, 'duplicate', `${where}: duplicate templateId.`);
    ids.add(t.templateId);
    if (t.executable !== pin.executable) {
      out.add(file, 'unsafe_command', `${where}: executable ${JSON.stringify(t.executable)} differs from the pinned ${JSON.stringify(pin.executable)}.`);
    }
    if (!sameArray(t.args, pin.args)) {
      out.add(file, 'unsafe_command', `${where}: args differ from the pinned argument list (strict, ordered equality is required).`);
    } else if (t.templateId === 'Health_Check' && sha256(t.args[1]) !== HEALTH_CHECK_SCRIPT_SHA256) {
      out.add(file, 'unsafe_command', `${where}: Health_Check script does not match its pinned SHA-256.`);
    }
    if (!sameArray(t.allowedParams, pin.allowedParams)) {
      out.add(file, 'unsafe_params', `${where}: allowedParams must be exactly [${pin.allowedParams.join(', ')}].`);
    }
    if (t.timeoutMs > pin.maxTimeoutMs) out.add(file, 'unsafe_limit', `${where}: timeoutMs ${t.timeoutMs} exceeds the cap of ${pin.maxTimeoutMs}.`);
  });
  for (const id of REQUIRED_TEMPLATE_IDS) {
    if (!ids.has(id)) out.add(file, 'missing_template', `Required command template ${id} is missing.`);
  }
  return doc.templates;
}

// ---------------------------------------------------------------- fallback mapping
function deepStrings(value, visit, keyVisit) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach((v) => deepStrings(v, visit, keyVisit));
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      keyVisit(k);
      deepStrings(v, visit, keyVisit);
    }
  }
}

/**
 * An entry matches a scenario when it would be selected from that scenario's observable effect
 * alone (no scenario ID involved): its health check is the scenario's component, its sourceCheck
 * text appears in the injected files but not in the baseline, and its plan restores the baseline.
 */
function entryMatchesScenario(entry, scenario, injectedState, baseline) {
  if (entry.evidencePattern.healthCheckId !== scenario.targetComponent) return false;
  const { file, contains } = entry.sourceCheck;
  if (!(injectedState.get(file) ?? '').includes(contains) || (baseline.get(file) ?? '').includes(contains)) return false;
  const { targetFile, change } = entry.planTemplate;
  const fixed = replaceOnce(injectedState.get(targetFile) ?? '', change.find, change.replace);
  return fixed !== null && fixed === baseline.get(targetFile);
}

/**
 * Shared pure runtime matcher. `evidence` is an array of Monitor-observable health check results
 * `{ healthCheckId, status, error }`; `readFile(relPath)` returns the current Approved_File
 * content (or undefined). Scenario IDs and chaos events are never inputs. An entry matches only
 * when a failing item for its health check has an error text matching errorPattern AND its
 * sourceCheck text is present in the current file content.
 */
export function fallbackEntryMatchesEvidence(entry, evidence, readFile) {
  if (!isObject(entry) || !Array.isArray(evidence) || typeof readFile !== 'function') return false;
  const { healthCheckId, errorPattern } = entry.evidencePattern ?? {};
  let re;
  try { re = new RegExp(errorPattern); } catch { return false; }
  const evidenceMatches = evidence.some((item) =>
    isObject(item) && item.healthCheckId === healthCheckId && item.status === 'fail'
    && typeof item.error === 'string' && re.test(item.error));
  if (!evidenceMatches) return false;
  const content = readFile(entry.sourceCheck?.file);
  return typeof content === 'string' && content.includes(entry.sourceCheck.contains);
}

function checkFallbackMapping(doc, ctx, out) {
  const file = CONFIG_FILES.fallbackMapping;
  const { approved, allowlist, scenarios, baseline } = ctx;
  const scenarioIds = [...REQUIRED_SCENARIO_IDS, ...((scenarios?.scenarios ?? []).map((s) => s.scenarioId))];

  // Scans of the raw document (they hold even when the schema also fails).
  const rawEntries = isObject(doc) && Array.isArray(doc.entries) ? doc.entries : [];
  rawEntries.forEach((e, i) => {
    const where = `mapping entry #${i}${isObject(e) && typeof e.entryId === 'string' ? ` (${e.entryId})` : ''}`;
    const leak = (text) => {
      const lower = text.toLowerCase();
      if (scenarioIds.some((id) => lower.includes(id.toLowerCase())) || /scenario[_-]?id/i.test(text)) {
        out.add(file, 'scenario_id_leak', `${where}: contains a scenario ID or scenario reference (${JSON.stringify(text.slice(0, 60))}).`);
      }
    };
    deepStrings(e, leak, leak);
    const plan = isObject(e) ? e.planTemplate : undefined;
    if (isObject(plan) && (Object.hasOwn(plan, 'command') || Object.hasOwn(plan, 'shell'))) {
      out.add(file, 'unsafe_command', `${where}: plan must not carry a command.`);
    }
  });

  if (!schemaErrors(out, file, 'FallbackMappingDocument', doc, 'Fallback_Mapping')) return;
  const approvedSet = approved ? new Set(approved) : null;

  const ids = new Set();
  const validEntries = [];
  doc.entries.forEach((e, i) => {
    const where = `mapping entry #${i} (${e.entryId})`;
    if (ids.has(e.entryId)) out.add(file, 'duplicate', `${where}: duplicate entryId.`);
    ids.add(e.entryId);
    const before = out.count;

    try { new RegExp(e.evidencePattern.errorPattern); } catch {
      out.add(file, 'invalid_evidence_pattern', `${where}: errorPattern is not a valid regular expression.`);
    }
    if (approvedSet && !approvedSet.has(e.sourceCheck.file)) {
      out.add(file, 'invalid_source_check', `${where}: sourceCheck.file must be an Approved_File.`);
    }
    const plan = e.planTemplate;
    if (e.diagnosisTemplate.suspectedFile !== plan.targetFile) {
      out.add(file, 'invalid_template', `${where}: diagnosis must name the same file as the plan target.`);
    }
    const entry = allowlist?.find((a) => a.actionType === plan.actionType);
    if (allowlist && (!entry || !entry.allowedFiles.includes(plan.targetFile) || (approvedSet && !approvedSet.has(plan.targetFile)))) {
      out.add(file, 'not_allowlisted', `${where}: plan action ${JSON.stringify(plan.actionType)} on ${JSON.stringify(plan.targetFile)} is not allowlisted.`);
    }
    if (!actionFileCompatible(plan.actionType, plan.targetFile)) {
      out.add(file, 'unsafe_action_file', `${where}: ${plan.actionType} cannot target ${JSON.stringify(plan.targetFile)}.`);
    }
    if (e.diagnosisTemplate.component !== e.evidencePattern.healthCheckId) {
      out.add(file, 'invalid_template', `${where}: diagnosis component must equal the evidence healthCheckId.`);
    }
    checkChangeSize(out, file, where, plan.change, entry);
    if (out.count === before) validEntries.push(e);
  });

  // Exactly-one coverage: every scenario is matched by exactly one entry and every entry by a scenario.
  if (!scenarios || !baseline) return;
  const covered = new Set();
  for (const s of scenarios.scenarios) {
    const injectedState = scenarios.injected.get(s.scenarioId);
    if (!injectedState) continue; // scenario itself already reported as invalid
    const matching = validEntries.filter((e) => entryMatchesScenario(e, s, injectedState, baseline));
    matching.forEach((e) => covered.add(e.entryId));
    if (matching.length === 0) {
      out.add(file, 'coverage_gap', `No fallback mapping entry diagnoses and repairs the failure produced by scenario ${s.scenarioId}.`);
    } else if (matching.length > 1) {
      out.add(file, 'ambiguous_mapping', `${matching.length} fallback mapping entries (${matching.map((e) => e.entryId).join(', ')}) match scenario ${s.scenarioId}; exactly one is required.`);
    }
  }
  if (scenarios.injected.size === scenarios.scenarios.length) {
    for (const e of validEntries) {
      if (!covered.has(e.entryId)) {
        out.add(file, 'orphan_entry', `Fallback mapping entry ${e.entryId} matches no approved demo scenario.`);
      }
    }
  }
}

// ---------------------------------------------------------------- public API
/**
 * Load and validate all configuration.
 * @param {{configDir?: string, testappDir?: string}} [options]
 * @returns {{ok: true, config: object} | {ok: false, errors: Array<{file: string, code: string, message: string}>}}
 */
export function loadConfig({ configDir = DEFAULT_CONFIG_DIR, testappDir = DEFAULT_TESTAPP_DIR } = {}) {
  const out = new Collector();
  const raw = {};
  for (const [key, fileName] of Object.entries(CONFIG_FILES)) raw[key] = readJson(configDir, fileName, out);

  const baseline = new Map();
  const approved = raw.approvedFiles === undefined ? undefined : checkApprovedFiles(raw.approvedFiles, testappDir, out, baseline);
  const allowlist = raw.actionAllowlist === undefined ? undefined : checkAllowlist(raw.actionAllowlist, approved, out);
  const scenarios = raw.scenarioCatalog === undefined ? undefined : checkScenarioCatalog(raw.scenarioCatalog, approved, allowlist, baseline, out);
  const templates = raw.commandTemplates === undefined ? undefined : checkCommandTemplates(raw.commandTemplates, out);
  if (raw.fallbackMapping !== undefined) {
    checkFallbackMapping(raw.fallbackMapping, { approved, allowlist, scenarios, baseline }, out);
  }

  if (out.count > 0) return { ok: false, errors: out.errors };
  return {
    ok: true,
    config: Object.freeze({
      testappDir: path.resolve(testappDir),
      approvedFiles: Object.freeze([...approved]),
      actionAllowlist: allowlist,
      scenarioCatalog: scenarios.scenarios,
      commandTemplates: templates,
      fallbackMapping: raw.fallbackMapping.entries,
      versions: {
        approvedFiles: raw.approvedFiles.version,
        scenarioCatalog: raw.scenarioCatalog.version,
        commandTemplates: raw.commandTemplates.version,
        fallbackMapping: raw.fallbackMapping.version,
      },
    }),
  };
}

/** Startup entry point: returns the config or throws ConfigError (initialization refused). */
export function initializeConfig(options) {
  const result = loadConfig(options);
  if (!result.ok) throw new ConfigError(result.errors);
  return result.config;
}
