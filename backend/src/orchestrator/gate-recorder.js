// Orchestrator-side recording of a Safety_Gate decision as a `gate` Event (Requirement 9.9).
// The gate itself does no I/O; the Orchestrator calls this after evaluate().
// The approval token is never put in the Event; only the plan hash is.

export async function recordGateDecision(eventLog, plan, decision, { runId = null } = {}) {
  const { approval, ...publicDecision } = decision;
  return eventLog.append({
    type: 'gate',
    component: 'safety-gate',
    incidentId: typeof plan?.incidentId === 'string' && plan.incidentId !== '' ? plan.incidentId : null,
    runId,
    payload: {
      decision: publicDecision.approved ? 'approved' : 'rejected',
      planHash: publicDecision.planHash,
      actionType: typeof plan?.actionType === 'string' ? plan.actionType : null,
      targetFile: typeof plan?.targetFile === 'string' ? plan.targetFile : null,
      rules: publicDecision.rules,
      reasons: publicDecision.reasons,
    },
  });
}
