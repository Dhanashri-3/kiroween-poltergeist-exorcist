// Poltergeist module (Task 10.10, Requirements 4.1-4.7).
//
// createPoltergeist({ catalogView, scenarioEngine, eventRecorder, chooser?, idFactory?, now? })
//   returns { select, startRun, recordBattleResult }.
//
//   catalogView      () => Array<{id,label,severity}> | the array itself. The public view only (4.1);
//                    any other field on an entry is dropped.
//   scenarioEngine   { inject(scenarioId, runId) }. The only way failures are triggered (4.2).
//   eventRecorder    { append(event) }. Records the selection and battle_result Events.
//   chooser          optional (publicView) => { scenarioId, rationale } | Promise. Used when the user
//                    gave no choice, for example an AI model. Its answer is validated against the
//                    catalog. Without it the Poltergeist picks at random using `random`.
//
// Tooling (4.3, 4.5): this module has no file system, shell, network, Exorcist, storage or
// Scenario_Engine imports. Everything it can do arrives through the injected objects above.
//
// Import rule: only contracts/ and this directory.

import { randomUUID } from 'node:crypto';

export const POLTERGEIST_COMPONENT = 'poltergeist';
export const SELECTION_EVENT_TYPE = 'chaos.selection';
export const BATTLE_RESULT_EVENT_TYPE = 'battle_result';
export const TERMINAL_INCIDENT_STATES = Object.freeze(['recovered', 'escalated']);

export class PoltergeistError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PoltergeistError';
    this.code = code;
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** Reduce catalog entries to the public fields only. */
function toPublicView(entries) {
  if (!Array.isArray(entries)) throw new PoltergeistError('invalid_catalog', 'The catalog public view must be an array.');
  return entries.map((e) => ({ id: e?.id, label: e?.label, severity: e?.severity }))
    .filter((e) => isNonEmptyString(e.id));
}

export function createPoltergeist(options = {}) {
  const { catalogView, scenarioEngine, eventRecorder, chooser, idFactory = randomUUID, random = Math.random } = options;
  if (typeof catalogView !== 'function' && !Array.isArray(catalogView)) throw new TypeError('catalogView is required');
  if (typeof scenarioEngine?.inject !== 'function') throw new TypeError('scenarioEngine.inject is required');
  if (typeof eventRecorder?.append !== 'function') throw new TypeError('eventRecorder.append is required');
  if (chooser !== undefined && typeof chooser !== 'function') throw new TypeError('chooser must be a function');

  const viewNow = async () => toPublicView(typeof catalogView === 'function' ? await catalogView() : catalogView);

  /**
   * Pick a Scenario and record the selection Event (4.1, 4.4, 4.6).
   * @param {{scenarioId?: string}} [request] a user choice from the Dashboard, used verbatim after validation
   * @returns {Promise<{runId: string, scenarioId: string, rationale: string}>}
   */
  async function select(request = {}) {
    const view = await viewNow();
    if (view.length === 0) throw new PoltergeistError('empty_catalog', 'The Scenario_Catalog has no entries.');
    const known = new Set(view.map((e) => e.id));

    let scenarioId;
    let rationale;
    const userChoice = request?.scenarioId;
    if (userChoice !== undefined && userChoice !== null) {
      if (typeof userChoice !== 'string' || !known.has(userChoice)) {
        throw new PoltergeistError('unknown_scenario', 'The chosen Scenario is not in the Scenario_Catalog.');
      }
      scenarioId = userChoice;
      rationale = 'Scenario chosen by the user on the Dashboard.';
    } else if (chooser) {
      const choice = await chooser(view.map((e) => ({ ...e })));
      if (typeof choice?.scenarioId !== 'string' || !known.has(choice.scenarioId)) {
        throw new PoltergeistError('unknown_scenario', 'The selected Scenario is not in the Scenario_Catalog.');
      }
      scenarioId = choice.scenarioId;
      rationale = isNonEmptyString(choice.rationale) ? choice.rationale : 'Selected by the Poltergeist.';
    } else {
      const picked = view[Math.min(view.length - 1, Math.floor(random() * view.length))];
      scenarioId = picked.id;
      rationale = `Selected at random from ${view.length} catalog Scenarios.`;
    }

    const runId = idFactory(); // independent of any Incident_ID (4.4)
    await eventRecorder.append({
      type: SELECTION_EVENT_TYPE,
      component: POLTERGEIST_COMPONENT,
      incidentId: null,
      runId,
      payload: { scenarioId, rationale, userSelected: userChoice !== undefined && userChoice !== null },
    });
    return { runId, scenarioId, rationale };
  }

  /** Select, then trigger the failure through the Scenario_Engine injection interface (4.2). */
  async function startRun(request = {}) {
    const selection = await select(request);
    await scenarioEngine.inject(selection.scenarioId, selection.runId);
    return selection;
  }

  /** Record the final battle result for a terminal Incident (4.7). */
  async function recordBattleResult({ runId, incidentId, state, summary } = {}) {
    if (!isNonEmptyString(runId)) throw new PoltergeistError('invalid_input', 'runId is required.');
    if (!isNonEmptyString(incidentId)) throw new PoltergeistError('invalid_input', 'incidentId is required.');
    if (!TERMINAL_INCIDENT_STATES.includes(state)) {
      throw new PoltergeistError('not_terminal', `Incident state '${state}' is not terminal.`);
    }
    const payload = { runId, incidentId, result: state === 'recovered' ? 'exorcist_win' : 'poltergeist_win', state };
    if (isNonEmptyString(summary)) payload.summary = summary;
    return eventRecorder.append({
      type: BATTLE_RESULT_EVENT_TYPE,
      component: POLTERGEIST_COMPONENT,
      incidentId,
      runId,
      payload,
    });
  }

  return { select, startRun, recordBattleResult };
}
