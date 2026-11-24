/**
 * SYNTHETIC Event sequences for UI-contract tests. Every Event here is written by the test through
 * the FAKE API. None of it is real chaos, real diagnosis, real repair or a real Verification_Result.
 * Payload shapes follow what the Dashboard selectors read (docs/event-schema.md, src/state/*).
 *
 * Req 15.10: the real `repair` Event carries checksums only (no file content), so these fixtures
 * carry checksums only. The Dashboard can show a plan-derived preview but never an actual diff.
 */

export const CHECKSUM_BEFORE = 'a'.repeat(64);
export const CHECKSUM_AFTER = 'b'.repeat(64);

const stateEvent = (incidentId, to, runId) => ({
  type: 'incident.state', component: 'incident-manager', incidentId, runId, payload: { to },
});

export function pushInjectionAndDetection(fake, { incidentId, runId, scenarioId = 'button-handler-removed' }) {
  fake.pushEvent({ type: 'chaos.selection', component: 'poltergeist', runId, payload: { scenarioId } });
  fake.pushEvent({ type: 'chaos.injection', component: 'poltergeist', runId, payload: { scenarioId, target: 'testapp/src/Button.jsx' } });
  fake.pushEvent({ type: 'detection', component: 'monitor', incidentId, runId, payload: { failingComponent: 'button' } });
  fake.pushEvent(stateEvent(incidentId, 'detected', runId));
  fake.addIncident({
    incidentId, state: 'detected', component: 'button', detectedAt: new Date().toISOString(),
    attemptCount: 0, evidenceRefs: [], terminalReason: null,
  });
}

export function pushDiagnosisPlanGateRepair(fake, { incidentId, runId }) {
  fake.pushEvent(stateEvent(incidentId, 'investigating', runId));
  fake.pushEvent({
    type: 'diagnosis', component: 'exorcist', incidentId, runId,
    payload: { diagnosis: { component: 'button', rootCause: 'onClick handler was removed (synthetic)' } },
  });
  fake.pushEvent(stateEvent(incidentId, 'planned', runId));
  fake.pushEvent({
    type: 'plan', component: 'exorcist', incidentId, runId,
    payload: {
      plan: {
        actionType: 'replace_text', targetFile: 'testapp/src/Button.jsx',
        rationale: 'Restore the onClick handler (synthetic).',
        change: { find: '<button>', replace: '<button onClick={handle}>' },
      },
    },
  });
  fake.pushEvent({ type: 'gate', component: 'safety-gate', incidentId, runId, payload: { decision: 'approved' } });
  fake.pushEvent(stateEvent(incidentId, 'repairing', runId));
  fake.pushEvent({
    type: 'repair', component: 'exorcist', incidentId, runId,
    payload: {
      incidentId, target: 'testapp/src/Button.jsx', snapshotId: 'snapshot-synthetic-1',
      preChecksum: CHECKSUM_BEFORE, postChecksum: CHECKSUM_AFTER,
      snapshotChecksums: [{ path: 'testapp/src/Button.jsx', checksum: CHECKSUM_BEFORE }],
    },
  });
}

/** A SYNTHETIC passing Verification_Result Event. Not a real verification. */
export function pushPassingVerification(fake, { incidentId, runId }) {
  fake.pushEvent(stateEvent(incidentId, 'verifying', runId));
  fake.pushEvent({
    type: 'verification', component: 'verifier', incidentId, runId,
    payload: {
      incidentId, verificationId: 'verification-synthetic-1', overall: 'pass', attemptNo: 1, durationMs: 1234,
      originalFailingCheckRan: true,
      checks: [{ checkId: 'check-1', kind: 'playwright', coversComponent: 'button', outcome: 'pass' }],
    },
  });
}

export function pushRecoveredIncident(fake, { incidentId, runId }) {
  pushInjectionAndDetection(fake, { incidentId, runId });
  pushDiagnosisPlanGateRepair(fake, { incidentId, runId });
  pushPassingVerification(fake, { incidentId, runId });
  fake.pushEvent(stateEvent(incidentId, 'recovered', runId));
}

export function pushEscalatedIncident(fake, { incidentId, runId, reason = 'verification failed twice (synthetic)' }) {
  pushInjectionAndDetection(fake, { incidentId, runId });
  pushDiagnosisPlanGateRepair(fake, { incidentId, runId });
  fake.pushEvent({
    type: 'rollback', component: 'file-guard', incidentId, runId,
    payload: { status: 'restored', snapshotId: 'snapshot-synthetic-1', reason: 'verification_failed', mismatches: [] },
  });
  fake.pushEvent({ type: 'escalation', component: 'exorcist', incidentId, runId, payload: { reason } });
  fake.pushEvent(stateEvent(incidentId, 'escalated', runId));
}

export function pushRolledBackIncident(fake, { incidentId, runId }) {
  pushInjectionAndDetection(fake, { incidentId, runId });
  pushDiagnosisPlanGateRepair(fake, { incidentId, runId });
  fake.pushEvent({
    type: 'rollback', component: 'file-guard', incidentId, runId,
    payload: { status: 'restored', snapshotId: 'snapshot-synthetic-1', reason: 'patch_rejected', mismatches: [] },
  });
  fake.pushEvent(stateEvent(incidentId, 'rolled_back', runId));
}

/** State says recovered but no passing verification Event exists. The Dashboard must not call it recovered. */
export function pushUnverifiedRecoveryClaim(fake, { incidentId, runId }) {
  pushInjectionAndDetection(fake, { incidentId, runId });
  fake.pushEvent(stateEvent(incidentId, 'recovered', runId));
}
