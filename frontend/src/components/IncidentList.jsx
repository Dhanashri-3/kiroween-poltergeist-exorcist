import { Badge, Empty } from './common.jsx';

/** Props: items [{incidentId, outcome}], selectedId, currentId, onSelect(id|null). */
export default function IncidentList({ items, selectedId, currentId, onSelect }) {
  return (
    <section className="panel" aria-labelledby="incidents-h" data-testid="incident-list-panel">
      <h2 id="incidents-h">Incidents</h2>
      {items.length === 0 ? <Empty testId="incidents-empty">No incidents.</Empty> : (
        <ul className="plain incident-list" data-testid="incident-list">
          {items.map(({ incidentId, outcome }) => (
            <li key={incidentId} data-testid="incident-item" data-outcome={outcome}>
              <button type="button" aria-current={incidentId === selectedId ? 'true' : undefined}
                onClick={() => onSelect(incidentId === currentId ? null : incidentId)}>
                {incidentId}
              </button>{' '}
              <Badge kind={outcome} data-testid="incident-outcome-badge">{outcome.replace(/_/g, ' ')}</Badge>
              {incidentId === currentId ? <span className="muted"> (current)</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
