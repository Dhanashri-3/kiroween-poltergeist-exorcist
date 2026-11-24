import { Badge, Empty, PayloadView } from './common.jsx';
import Timeline from './Timeline.jsx';
import { OUTCOMES } from '../state/dashboardReducer.js';

const val = (v) => (v === null || v === undefined || v === '' ? 'not available' : String(v));

export function VerificationPanel({ verification, testId = 'verification', id }) {
  if (!verification) return <Empty testId={`${testId}-none`}>No Verification_Result yet.</Empty>;
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  return (
    <div id={id} data-testid={testId} data-overall={verification.overall}>
      <p>
        Verification_Result <span className="mono">{val(verification.verificationId)}</span>:{' '}
        <Badge kind={verification.overall === 'pass' ? 'recovered' : 'escalated'} data-testid={`${testId}-overall`}>
          {verification.overall ?? 'unknown'}
        </Badge>
        {verification.attemptNo !== undefined ? <span className="muted"> attempt {verification.attemptNo}</span> : null}
        {verification.durationMs !== undefined ? <span className="muted"> {verification.durationMs} ms</span> : null}
      </p>
      {verification.originalFailingCheckRan !== undefined
        ? <p className="muted">Original failing check ran: {String(verification.originalFailingCheckRan)}</p> : null}
      {checks.length > 0 ? (
        <ul className="plain">
          {checks.map((c, i) => (
            <li key={c.checkId ?? i} data-testid="verification-check">
              {val(c.kind)} / {val(c.coversComponent)}: <strong>{val(c.outcome)}</strong>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RollbackList({ rollbacks }) {
  if (rollbacks.length === 0) return <Empty testId="rollback-none">No rollback evidence recorded.</Empty>;
  return (
    <ul className="plain" data-testid="rollback-list">
      {rollbacks.map((r, i) => (
        <li key={i} data-testid="rollback-item" data-status={r.status}>
          Rollback <strong>{val(r.status)}</strong> (snapshot {val(r.snapshotId)}, reason {val(r.reason)})
          {Array.isArray(r.mismatches) && r.mismatches.length > 0 ? <span> mismatches: {r.mismatches.length}</span> : null}
          <PayloadView payload={r} label="rollback evidence" />
        </li>
      ))}
    </ul>
  );
}

function OutcomeBanner({ view }) {
  const { outcome } = view;
  const common = { 'data-testid': 'outcome', 'data-outcome': outcome, className: `outcome outcome--${outcome}` };
  switch (outcome) {
    case OUTCOMES.RECOVERED:
      return (
        <div {...common}>
          <h3>Recovered (verified)</h3>
          <p>
            Supported by this passing Verification_Result:{' '}
            <a href="#recovery-verification-panel" data-testid="recovery-verification-link">
              Go to Verification_Result {val(view.recoveryVerification?.verificationId)}
            </a>
          </p>
          <VerificationPanel verification={view.recoveryVerification} testId="recovery-verification"
            id="recovery-verification-panel" />
        </div>
      );
    case OUTCOMES.UNVERIFIED_RECOVERY_CLAIM:
      return (
        <div {...common} role="alert">
          <h3>NOT VERIFIED: recovery claimed without a passing verification</h3>
          <p>The Incident state says recovered, but no passing verification Event exists. This is not a recovery.</p>
        </div>
      );
    case OUTCOMES.ESCALATED:
      return (
        <div {...common}>
          <h3>Escalated: repair failed</h3>
          <p data-testid="escalation-reason">Reason: {val(view.terminalReason)}</p>
          <h3>Rollback evidence</h3>
          <RollbackList rollbacks={view.rollbacks} />
          {view.escalation ? <PayloadView payload={view.escalation} label="escalation record" /> : null}
        </div>
      );
    case OUTCOMES.ROLLED_BACK:
      return (
        <div {...common}>
          <h3>Rolled back</h3>
          <RollbackList rollbacks={view.rollbacks} />
        </div>
      );
    case OUTCOMES.ACTIVE:
      return (
        <div {...common}>
          <h3>In progress</h3>
          <p>State: {val(view.state)}</p>
        </div>
      );
    default:
      return (
        <div {...common}>
          <h3>No outcome</h3>
        </div>
      );
  }
}

function PlanItem({ item }) {
  const plan = item.plan && typeof item.plan === 'object' ? item.plan : null;
  return (
    <li data-testid="plan-item" data-rejected={String(item.rejected === true)}>
      {plan ? (
        <>
          <strong>{val(plan.actionType)}</strong> on <span className="mono">{val(plan.targetFile)}</span>
          {item.rejected === true ? <span> (rejected)</span> : null}
          <div className="muted">{val(plan.rationale)}</div>
        </>
      ) : <span>Plan data not available</span>}
      <PayloadView payload={item} label="plan details" />
    </li>
  );
}

function DiffLines({ text, kind }) {
  const removed = kind === 'del';
  return text.split('\n').map((line, i) => (
    <span key={i} className={removed ? 'diff__line diff__line--del' : 'diff__line diff__line--add'}
      data-testid={removed ? 'preview-removed-line' : 'preview-added-line'}>
      <span className="visually-hidden">{removed ? 'Removed line: ' : 'Added line: '}</span>
      <span aria-hidden="true">{removed ? '- ' : '+ '}</span>{line}{'\n'}
    </span>
  ));
}

function PlanPreview({ preview }) {
  if (!preview) {
    return <Empty testId="plan-preview-unavailable">Plan-derived preview not available.</Empty>;
  }
  return (
    <div data-testid="plan-preview">
      <h4>Plan-derived preview (NOT the actual file change)</h4>
      <p className="muted">
        This is what the Repair_Plan specified (find / replace), taken from the plan Event (seq {preview.planSeq}).
        It is not a before/after diff of the file. The file content before and after is not available from the Events.
      </p>
      {preview.targetMismatch ? (
        <p role="alert" className="alert" data-testid="plan-preview-mismatch">
          Plan target differs from repair target (plan: {val(preview.planTarget)}).
        </p>
      ) : null}
      <pre className="diff" data-testid="plan-preview-lines" aria-label="Repair_Plan find and replace preview">
        <DiffLines text={preview.find} kind="del" />
        <DiffLines text={preview.replace} kind="add" />
      </pre>
    </div>
  );
}

function RepairSection({ repair }) {
  if (!repair) return <Empty testId="repair-none">No repair applied.</Empty>;
  if (repair.omitted) return <p data-testid="repair-omitted" className="muted">repair payload omitted ({repair.bytes} bytes)</p>;
  const compare = repair.checksumsDiffer === null
    ? 'not available'
    : (repair.checksumsDiffer ? 'different' : 'equal');
  return (
    <div data-testid="repair">
      <h4>Repair record (from repair Event)</h4>
      <dl className="kv" data-testid="repair-record">
        <dt>Target</dt><dd data-testid="repair-target">{val(repair.target)}</dd>
        <dt>Snapshot</dt><dd data-testid="repair-snapshot">{val(repair.snapshotId)}</dd>
        <dt>Checksum before</dt><dd className="mono" data-testid="repair-pre">{val(repair.preChecksum)}</dd>
        <dt>Checksum after</dt><dd className="mono" data-testid="repair-post">{val(repair.postChecksum)}</dd>
        <dt>Checksums</dt><dd data-testid="repair-compare">{compare}</dd>
      </dl>
      {repair.snapshotChecksums.length > 0 ? (
        <ul className="plain" data-testid="repair-snapshot-checksums">
          {repair.snapshotChecksums.map((c) => (
            <li key={c.path} className="mono">{c.path}: {c.checksum}</li>
          ))}
        </ul>
      ) : null}
      <PlanPreview preview={repair.preview} />
    </div>
  );
}

/**
 * Props: view = selectIncidentView(state, id), repair = selectRepairView, events = selectIncidentEvents,
 * evidenceRefs = selectIncidentEvidenceRefs, isCurrent.
 */
export default function IncidentDetails({ view, repair, events, evidenceRefs, isCurrent }) {
  if (!view) return <Empty testId="incident-unknown">Incident not found.</Empty>;
  return (
    <section className="panel" aria-labelledby="incident-h" data-testid="incident-panel" data-outcome={view.outcome}>
      <h2 id="incident-h">{isCurrent ? 'Current incident' : 'Past incident'}: <span className="mono">{view.incidentId}</span></h2>
      <OutcomeBanner view={view} />
      <dl className="kv">
        <dt>State</dt><dd data-testid="incident-state">{val(view.state)}</dd>
        <dt>Component</dt><dd data-testid="incident-component">{val(view.component)}</dd>
        <dt>Attempts</dt><dd data-testid="incident-attempts">{view.attemptCount}</dd>
      </dl>
      <h3>Diagnosis</h3>
      {view.diagnosis ? <PayloadView payload={view.diagnosis} label="diagnosis" /> : <Empty testId="diagnosis-none">No diagnosis yet.</Empty>}
      <h3>Repair_Plan</h3>
      {view.plans.length === 0 ? <Empty testId="plans-none">No plan yet.</Empty> : (
        <ul className="plain" data-testid="plan-list">{view.plans.map((p, i) => <PlanItem key={i} item={p} />)}</ul>
      )}
      <h3>Gate decision</h3>
      {view.gateDecisions.length === 0 ? <Empty testId="gate-none">No gate decision yet.</Empty> : (
        <ul className="plain" data-testid="gate-list">
          {view.gateDecisions.map((g, i) => <li key={i} data-testid="gate-item"><PayloadView payload={g} label="gate decision" /></li>)}
        </ul>
      )}
      <h3>Repair</h3>
      <RepairSection repair={repair} />
      <h3>Latest Verification_Result</h3>
      <VerificationPanel verification={view.verification} />
      <h3>Evidence</h3>
      {evidenceRefs.length === 0 ? <Empty testId="evidence-none">No Evidence references recorded for this Incident.</Empty> : (
        <ul className="plain" data-testid="evidence-list">
          {evidenceRefs.map((r) => <li key={r} className="mono" data-testid="evidence-item">{r}</li>)}
        </ul>
      )}
      <Timeline events={events} title="Incident events" testId="incident-events" />
    </section>
  );
}
