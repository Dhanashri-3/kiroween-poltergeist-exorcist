/**
 * Incidents that belong to no Defense Mesh card: component `app`, a component outside the four card keys,
 * or a component not reported yet. They are listed here instead of being attached to an arbitrary card.
 * Renders nothing when there are none. Props: items = deriveMeshView().appLevel.
 */
export default function AppLevelIncidents({ items = [] }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="so-applevel" data-testid="so-applevel">
      <h3 id="so-applevel-h" className="so-applevel__title">App-level incidents</h3>
      <ul className="so-applevel__list" aria-labelledby="so-applevel-h">
        {items.map((i) => (
          <li key={i.incidentId} className="so-applevel__item" data-testid="so-applevel-item" data-outcome={i.outcome}>
            <code>{i.incidentId}</code>
            <span className="so-applevel__scope">{i.scope}</span>
            <span className={`so-chip so-chip--${i.outcome}`}>{i.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
