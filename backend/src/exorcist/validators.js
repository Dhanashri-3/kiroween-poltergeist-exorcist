// Diagnosis and Repair_Plan validators (Task 10.3, Requirements 7.2, 7.5, 7.8, 7.9, 8.1, 8.2, 8.3, 8.6).
//
// Import rule: only contracts/ is imported. The Action_Allowlist and the previously failed plans
// are passed in by the Orchestrator, so this module touches no storage and no poltergeist/ code.
//
// validateDiagnosis(value) -> { outcome, valid, diagnosis, errors, countsAsAttempt }
//   outcome 'accepted'     schema valid, status is not 'inconclusive', confidence >= 0.5
//   outcome 'inconclusive' no Diagnosis object (7.9), status 'inconclusive', or confidence < 0.5 (7.5);
//                          the Incident_Manager escalates; this is not a Retry_Budget attempt
//   outcome 'rejected'     schema invalid (7.8); counts as one attempt against the Retry_Budget
//
// validateRepairPlan(plan, { allowlist, failedPlans }) -> { valid, errors, identicalToFailed, countsAsAttempt }
//   Every rejection (structure, action, command field, or identical to a failed plan, 8.6)
//   counts as one attempt against the Retry_Budget.

import { validate } from '../contracts/index.js';

export const CONFIDENCE_THRESHOLD = 0.5;

/** Keys that would carry something executable; rejected at any depth of a Repair_Plan. */
const COMMAND_KEYS = new Set(['command', 'cmd', 'shell', 'script', 'exec', 'execute', 'run', 'args', 'argv']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const err = (path, keyword, message) => ({ path, keyword, message, params: {} });

// ------------------------------------------------------------------------------- Diagnosis

export function validateDiagnosis(value) {
  if (value === undefined || value === null) {
    return {
      outcome: 'inconclusive',
      valid: false,
      diagnosis: null,
      errors: [err('/', 'missing', 'No Diagnosis was produced')],
      countsAsAttempt: false,
    };
  }

  const result = validate('Diagnosis', value);
  if (!result.valid) {
    return { outcome: 'rejected', valid: false, diagnosis: null, errors: result.errors, countsAsAttempt: true };
  }

  if (value.status === 'inconclusive' || value.confidence < CONFIDENCE_THRESHOLD) {
    return { outcome: 'inconclusive', valid: true, diagnosis: value, errors: [], countsAsAttempt: false };
  }
  return { outcome: 'accepted', valid: true, diagnosis: value, errors: [], countsAsAttempt: false };
}

// ------------------------------------------------------------------------------ Repair_Plan

/** Deterministic JSON with sorted object keys (local copy; Exorcist may not import safety-gate/). */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Identity of a plan for repeat detection: what it does, not why (rationale is ignored). */
function planIdentity(plan) {
  return canonicalize({
    incidentId: plan.incidentId,
    actionType: plan.actionType,
    targetFile: plan.targetFile,
    change: plan.change,
  });
}

function findCommandKeys(value, path, found) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findCommandKeys(v, `${path}/${i}`, found));
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (COMMAND_KEYS.has(k.toLowerCase())) found.push(`${path}/${k}`);
      findCommandKeys(v, `${path}/${k}`, found);
    }
  }
  return found;
}

/** True when `plan` repeats (same incident, action, target and change) a plan in `failedPlans`. */
export function isIdenticalToFailedPlan(plan, failedPlans = []) {
  if (!isObject(plan) || !Array.isArray(failedPlans)) return false;
  const identity = planIdentity(plan);
  return failedPlans.some((p) => isObject(p) && planIdentity(p) === identity);
}

/**
 * @param {unknown} plan
 * @param {{allowlist?: Array<{actionType: string}>, failedPlans?: object[]}} [options]
 */
export function validateRepairPlan(plan, { allowlist = [], failedPlans = [] } = {}) {
  const errors = [];

  // Command fields are reported first, whatever else is wrong (8.3).
  for (const p of findCommandKeys(plan, '', [])) {
    errors.push(err(p || '/', 'noCommand', 'A Repair_Plan must not contain a command field'));
  }

  const schema = validate('RepairPlan', plan);
  if (!schema.valid) {
    // additionalProperties on the top level is already reported as noCommand when it is a command key.
    errors.push(...schema.errors);
  } else {
    // 8.1: action must be in the Action_Allowlist.
    const allowed = Array.isArray(allowlist) && allowlist.some((e) => isObject(e) && e.actionType === plan.actionType);
    if (!allowed) {
      errors.push(err('/actionType', 'notAllowlisted', `Action "${plan.actionType}" is not in the Action_Allowlist`));
    }
    // 8.2: exactly one target file. The schema forces a single string; reject list-like values.
    if (/[\r\n,;|]/.test(plan.targetFile)) {
      errors.push(err('/targetFile', 'singleTarget', 'targetFile must name exactly one file'));
    }
  }

  // 8.6: identical to a previously failed plan (only meaningful for a structurally valid plan).
  const identicalToFailed = schema.valid && isIdenticalToFailedPlan(plan, failedPlans);
  if (identicalToFailed) {
    errors.push(err('/', 'identicalToFailedPlan', 'Repair_Plan is identical to a previously failed plan for this Incident'));
  }

  const valid = errors.length === 0;
  return { valid, errors, identicalToFailed, countsAsAttempt: !valid };
}
