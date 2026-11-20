// Incident state machine transition table (design.md "Incident Lifecycle").
// This table is the single source of truth for permitted transitions (Requirements 6.2, 6.3, 6.4).
import { INCIDENT_STATES } from '../contracts/common.js';

export const STATES = Object.freeze([...INCIDENT_STATES]);

// recovered and escalated are terminal. rolled_back is transient (Requirement 6.3).
export const TERMINAL_STATES = Object.freeze(['recovered', 'escalated']);

const table = {
  detected: ['investigating', 'escalated'],
  investigating: ['planned', 'escalated'],
  planned: ['repairing', 'investigating', 'escalated', 'rolled_back'],
  repairing: ['verifying', 'rolled_back', 'escalated'],
  verifying: ['recovered', 'rolled_back', 'escalated'],
  rolled_back: ['investigating', 'escalated'],
  recovered: [],
  escalated: [],
};

export const TRANSITIONS = Object.freeze(
  Object.fromEntries(Object.entries(table).map(([from, tos]) => [from, Object.freeze([...tos])])),
);

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Decide whether `from -> to` is permitted.
 * Context preconditions:
 *  - to === 'rolled_back' requires context.rollbackVerified === true: a Rollback restored the
 *    Approved_Files and the restored checksums equal the Snapshot checksums (Requirement 6.4).
 *  - to === 'verifying' requires context.executorCompleted === true: only from `repairing`,
 *    after a completed executor record (Requirement 10.11).
 * Returns { ok: true } or { ok: false, reason }.
 */
export function checkTransition(from, to, context = {}) {
  if (!STATES.includes(from)) return { ok: false, reason: `unknown state: ${String(from)}` };
  if (!STATES.includes(to)) return { ok: false, reason: `unknown state: ${String(to)}` };
  if (isTerminal(from)) return { ok: false, reason: `${from} is terminal` };
  if (!TRANSITIONS[from].includes(to)) return { ok: false, reason: `transition ${from} -> ${to} is not permitted` };
  if (to === 'rolled_back' && context?.rollbackVerified !== true) {
    return { ok: false, reason: 'rolled_back requires a rollback with restored checksums verified equal to the snapshot' };
  }
  if (to === 'verifying' && context?.executorCompleted !== true) {
    return { ok: false, reason: 'verifying requires a completed executor record' };
  }
  return { ok: true };
}

export function canTransition(from, to, context = {}) {
  return checkTransition(from, to, context).ok;
}
