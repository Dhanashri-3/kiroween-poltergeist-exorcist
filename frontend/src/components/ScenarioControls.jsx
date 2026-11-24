import { useEffect, useRef, useState } from 'react';
import { Empty } from './common.jsx';

const withCode = (e) => {
  const message = typeof e?.message === 'string' && e.message !== '' ? e.message : 'Request failed.';
  return typeof e?.code === 'string' && e.code !== '' ? `${message} (${e.code})` : message;
};

/** Maps a failed control request to the text shown to the user. No state transition is claimed. */
export function describeControlError(e) {
  if (e?.code === 'incident_active') {
    return `An Incident is still active; try again when it is terminal. Server: ${withCode(e)}`;
  }
  return withCode(e);
}

const startNotice = (response) => {
  const runId = typeof response?.runId === 'string' && response.runId !== '' ? ` (runId ${response.runId})` : '';
  return `Chaos run request accepted${runId}. Waiting for Events; health and Incident state are shown only from Events.`;
};
const RESET_NOTICE =
  'Reset request accepted. This does not confirm the Test_App is restored or healthy; check health and Events.';

/**
 * Props: scenarios (state.scenarios), onStartChaos(scenarioId|undefined) and onReset() returning promises
 * (the hook's startChaos / reset). Nothing here changes health or Incident display (Req 15.8).
 * A synchronous in-flight ref blocks a second activation before React re-renders the disabled state.
 */
export default function ScenarioControls({ scenarios, onStartChaos, onReset }) {
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const list = Array.isArray(scenarios) ? scenarios : [];
  // A selected scenario that left the list falls back to a random scenario.
  const effective = list.some((s) => s.id === selected) ? selected : '';

  async function run(fn, onSuccess) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fn();
      if (mounted.current) setNotice(onSuccess(response));
    } catch (e) {
      if (mounted.current) setError(describeControlError(e));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="controls-h" aria-busy={busy} data-testid="scenario-controls">
      <h2 id="controls-h">Chaos controls</h2>
      {list.length === 0 ? <Empty testId="scenarios-empty">No scenarios available.</Empty> : (
        <ul className="plain" data-testid="scenario-list">
          {list.map((s) => (
            <li key={s.id} data-testid="scenario-item">{s.label ?? s.id}{s.severity ? <span className="muted"> [{s.severity}]</span> : null}</li>
          ))}
        </ul>
      )}
      <div className="controls">
        <label>
          Scenario{' '}
          <select value={effective} onChange={(e) => setSelected(e.target.value)} disabled={busy} data-testid="scenario-select">
            <option value="">Random scenario</option>
            {list.map((s) => <option key={s.id} value={s.id}>{s.label ?? s.id}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy}
          onClick={() => run(() => onStartChaos(effective === '' ? undefined : effective), startNotice)}>
          Start chaos
        </button>
        <button type="button" disabled={busy} onClick={() => run(() => onReset(), () => RESET_NOTICE)}>
          Reset
        </button>
      </div>
      <div aria-live="polite" data-testid="control-feedback">
        {busy ? <p className="muted" data-testid="control-pending">Request in progress...</p> : null}
        {error ? <div role="alert" className="alert" data-testid="control-error">{error}</div> : null}
        {notice ? <p className="muted" data-testid="control-notice">{notice}</p> : null}
      </div>
    </section>
  );
}
