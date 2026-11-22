// Fallback_Mapping engine (Task 10.6, Requirements 16.6, 16.8, 16.10).
//
// matchFallbackMapping({ entries, evidence, sources }) deterministically maps Incident Evidence and
// Approved_Files content to a rule-based Diagnosis and Repair_Plan.
//
//   entries   the `entries` array of fallback-mapping.json
//   evidence  the Incident's Evidence (healthCheckResults: [{ healthCheckId, status, error }])
//   sources   [{ path, content }] read-only Approved_Files content (same shape the input builder emits)
//
// Result: { matched: true, entryId, diagnosis, plan }
//      or { matched: false, reason }   ('no_evidence' | 'no_entries' | 'no_match' | 'invalid_output')
//
// Information barrier: the function has no parameter for a scenario ID or Event_Log, and entries
// contain no scenario ID. The first entry (in array order) whose evidence pattern AND source check
// both match is used, so repeated calls with the same input return the same output.
//
// Import rule: only contracts/ is imported.

import { validate } from '../contracts/index.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const normPath = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/').replace(/^\.\//, '') : p);

function sourceContent(sources, file) {
  if (!Array.isArray(sources)) return undefined;
  const wanted = normPath(file);
  const hit = sources.find((s) => isObject(s) && normPath(s.path) === wanted);
  return hit && typeof hit.content === 'string' ? hit.content : undefined;
}

/** True when a failing health check result matches the pattern AND the source check text is present. */
export function entryMatches(entry, evidence, sources) {
  if (!isObject(entry) || !isObject(entry.evidencePattern) || !isObject(entry.sourceCheck)) return false;
  const { healthCheckId, status, errorPattern } = entry.evidencePattern;
  let re;
  try {
    re = new RegExp(errorPattern);
  } catch {
    return false;
  }
  const results = Array.isArray(evidence?.healthCheckResults) ? evidence.healthCheckResults : [];
  const evidenceMatches = results.some(
    (r) => isObject(r) && r.healthCheckId === healthCheckId && r.status === status
      && typeof r.error === 'string' && re.test(r.error),
  );
  if (!evidenceMatches) return false;
  const content = sourceContent(sources, entry.sourceCheck.file);
  return typeof content === 'string' && content.includes(entry.sourceCheck.contains);
}

export function matchFallbackMapping({ entries, evidence, sources } = {}) {
  if (!isObject(evidence) || !Array.isArray(evidence.healthCheckResults)) return { matched: false, reason: 'no_evidence' };
  if (!Array.isArray(entries) || entries.length === 0) return { matched: false, reason: 'no_entries' };

  const entry = entries.find((e) => entryMatches(e, evidence, sources));
  if (!entry) return { matched: false, reason: 'no_match' };

  const incidentId = evidence.incidentId;
  const d = entry.diagnosisTemplate;
  const p = entry.planTemplate;
  const diagnosis = {
    incidentId,
    component: d.component,
    suspectedFile: d.suspectedFile,
    location: d.location,
    rootCause: d.rootCause,
    confidence: d.confidence,
    evidenceUsed: typeof evidence.evidenceId === 'string' && evidence.evidenceId !== '' ? [evidence.evidenceId] : [],
    status: 'rule_based',
  };
  const plan = {
    incidentId,
    actionType: p.actionType,
    targetFile: p.targetFile,
    change: structuredClone(p.change),
    rationale: p.rationale,
  };

  if (!validate('Diagnosis', diagnosis).valid || !validate('RepairPlan', plan).valid) {
    return { matched: false, reason: 'invalid_output' };
  }
  return { matched: true, entryId: entry.entryId, diagnosis, plan };
}
