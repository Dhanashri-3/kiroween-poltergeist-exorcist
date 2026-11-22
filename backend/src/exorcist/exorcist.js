// Exorcist module with source selection (Task 10.8, Requirements 7.1, 7.3, 8.1, 8.5, 13.9, 16.5, 16.6, 16.8, 16.9).
//
// createExorcist({ aiClient, fallbackEntries }) returns { diagnose, plan }.
//
//   diagnose(input)                      input is the output of buildExorcistInput (10.1)
//   plan(diagnosis, input)               input.priorAttempts carries each failed plan and its
//                                        Verification_Result; the returned plan must differ from them
//
// Both return a structured outcome and never throw for an unavailable source:
//   { outcome: 'ok', source: 'ai' | 'rule_based', diagnosis | plan }
//   { outcome: 'no_source', reason }   the Orchestrator records an error Event, rolls back if needed and
//                                      escalates (16.5). 'reason' is 'ai_unavailable_no_mapping_match'
//                                      or 'no_different_plan'.
//
// Source selection: while the AI service is available it is used (16.9). When it is unavailable and a
// Fallback_Mapping entry matches the Evidence, the mapping is used and the Diagnosis is marked
// `rule_based` (16.6, 16.8). Otherwise there is no source. The Orchestrator, not this module, handles
// the 60 s timeout, schema validation and gate rejection (no substitute plan after a mapping rejection).
//
// Tooling: the Exorcist has no file-write or shell capability. This module imports no fs, child_process
// or network module; the only I/O is through the injected AI client (7.3, 17.5).
//
// Credential (13.9): readAiCredential reads an environment variable only. No code here writes it anywhere.
//
// AI client interface (documented, no SDK dependency until the provider is chosen and reviewed):
//   isAvailable(): boolean | Promise<boolean>
//   diagnose(input): Diagnosis | Promise<Diagnosis>
//   plan({ diagnosis, input, priorAttempts }): Repair_Plan | Promise<Repair_Plan>
//
// Import rule: only contracts/ and this directory.

import { matchFallbackMapping } from './fallback-mapping.js';
import { isIdenticalToFailedPlan } from './validators.js';

export const AI_CREDENTIAL_ENV_VAR = 'EXORCIST_AI_API_KEY';

/** Reads the AI credential from the environment. Returns undefined when absent or empty. */
export function readAiCredential(env = process.env, name = AI_CREDENTIAL_ENV_VAR) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Stub AI client: always unavailable, so the Fallback_Mapping or escalation applies. */
export function createStubAiClient() {
  return {
    isAvailable: () => false,
    diagnose: async () => { throw new Error('AI service is not configured'); },
    plan: async () => { throw new Error('AI service is not configured'); },
  };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function aiAvailable(client) {
  try {
    return typeof client?.isAvailable === 'function' && (await client.isAvailable()) === true;
  } catch {
    return false;
  }
}

/** Failed plans from the input's prior attempts, oldest first. */
export function failedPlansOf(priorAttempts) {
  return (Array.isArray(priorAttempts) ? priorAttempts : [])
    .map((a) => a?.plan)
    .filter((p) => isObject(p) && Object.keys(p).length > 0);
}

/** Tries the newest Evidence first; returns the first mapping match. */
function mappingFor(entries, input) {
  const evidenceList = Array.isArray(input?.evidence) ? [...input.evidence].reverse() : [];
  let last = { matched: false, reason: 'no_evidence' };
  for (const evidence of evidenceList) {
    const result = matchFallbackMapping({ entries, evidence, sources: input.sources });
    if (result.matched) return result;
    last = result;
  }
  return last;
}

export function createExorcist({ aiClient = createStubAiClient(), fallbackEntries = [] } = {}) {
  async function diagnose(input) {
    if (await aiAvailable(aiClient)) {
      try {
        const diagnosis = await aiClient.diagnose(input);
        return { outcome: 'ok', source: 'ai', diagnosis };
      } catch {
        // The AI call failed: treat the service as unavailable and try the mapping below.
      }
    }
    const mapped = mappingFor(fallbackEntries, input);
    if (mapped.matched) return { outcome: 'ok', source: 'rule_based', diagnosis: mapped.diagnosis, entryId: mapped.entryId };
    return { outcome: 'no_source', reason: 'ai_unavailable_no_mapping_match' };
  }

  async function plan(diagnosis, input) {
    const failedPlans = failedPlansOf(input?.priorAttempts);

    if (diagnosis?.status !== 'rule_based' && (await aiAvailable(aiClient))) {
      try {
        const repairPlan = await aiClient.plan({
          diagnosis,
          input,
          priorAttempts: input?.priorAttempts ?? [],
        });
        // 8.5: a retry must differ from every failed plan. The Orchestrator counts an identical
        // plan as a rejected attempt (8.6), so it is returned flagged rather than hidden.
        return { outcome: 'ok', source: 'ai', plan: repairPlan, identicalToFailed: isIdenticalToFailedPlan(repairPlan, failedPlans) };
      } catch {
        // fall through to the mapping
      }
    }

    const mapped = mappingFor(fallbackEntries, input);
    if (!mapped.matched) return { outcome: 'no_source', reason: 'ai_unavailable_no_mapping_match' };
    // The mapping is deterministic, so a repeat would be the same plan. Do not offer it again.
    if (isIdenticalToFailedPlan(mapped.plan, failedPlans)) return { outcome: 'no_source', reason: 'no_different_plan' };
    return { outcome: 'ok', source: 'rule_based', plan: mapped.plan, entryId: mapped.entryId };
  }

  return { diagnose, plan };
}
