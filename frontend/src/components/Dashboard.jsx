import { useState } from 'react';
import '../styles/dashboard.css';
import {
  selectTimeline, selectHealth, selectIncidentIds, selectCurrentIncidentId,
  selectIncidentView, selectIncidentOutcome,
} from '../state/dashboardReducer.js';
import { selectIncidentEvents, selectIncidentEvidenceRefs, selectRepairView } from '../state/dashboardViews.js';
import ConnectionStatus from './ConnectionStatus.jsx';
import HealthPanel from './HealthPanel.jsx';
import ScenarioControls from './ScenarioControls.jsx';
import IncidentList from './IncidentList.jsx';
import IncidentDetails from './IncidentDetails.jsx';
import Timeline from './Timeline.jsx';

/**
 * Props: state (reducer state), connection {status, error, lastSeq}, onStartChaos, onReset.
 * Everything displayed comes from reducer selectors; no outcome is computed here.
 */
export default function Dashboard({ state, connection, onStartChaos, onReset }) {
  const [selectedId, setSelectedId] = useState(null);

  const health = selectHealth(state);
  const timeline = selectTimeline(state);
  const ids = selectIncidentIds(state);
  const currentId = selectCurrentIncidentId(state);
  const shownId = selectedId !== null && ids.includes(selectedId) ? selectedId : currentId;
  const items = ids.map((incidentId) => ({ incidentId, outcome: selectIncidentOutcome(state, incidentId) }));

  const loading = connection.status === 'connecting' && health === null && timeline.length === 0 &&
    ids.length === 0 && state.scenarios.length === 0;

  return (
    <main className="dashboard">
      <header className="dashboard__header">
        <h1>Poltergeist vs. Exorcist</h1>
        <ConnectionStatus status={connection.status} error={connection.error} lastSeq={connection.lastSeq} />
      </header>
      {loading ? <p role="status" data-testid="loading">Loading dashboard data…</p> : null}
      <div className="dashboard__grid">
        <HealthPanel health={health}
          idleNote={shownId === null ? 'Idle: no incident. Showing the latest known health.' : null} />
        <ScenarioControls scenarios={state.scenarios} onStartChaos={onStartChaos} onReset={onReset} />
        {shownId === null ? (
          <section className="panel dashboard__wide" aria-labelledby="idle-h" data-testid="idle">
            <h2 id="idle-h">Idle</h2>
            <p>No incident exists.</p>
          </section>
        ) : (
          <div className="dashboard__wide" data-testid="incident-area">
            {shownId !== currentId ? (
              <button type="button" onClick={() => setSelectedId(null)}>Back to current incident</button>
            ) : null}
            <IncidentDetails
              view={selectIncidentView(state, shownId)}
              repair={selectRepairView(state, shownId)}
              events={selectIncidentEvents(state, shownId)}
              evidenceRefs={selectIncidentEvidenceRefs(state, shownId)}
              isCurrent={shownId === currentId}
            />
          </div>
        )}
        <IncidentList items={items} selectedId={shownId} currentId={currentId} onSelect={setSelectedId} />
        <Timeline events={timeline} />
      </div>
    </main>
  );
}
