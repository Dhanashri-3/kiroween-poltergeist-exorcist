import { Badge, Empty } from './common.jsx';

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Props: health = selectHealth(state) (response of GET /health) or null. */
export default function HealthPanel({ health, idleNote }) {
  return (
    <section className="panel" aria-labelledby="health-h" data-testid="health-panel">
      <h2 id="health-h">Component health</h2>
      {health === null || health === undefined ? (
        <Empty testId="health-unavailable">No health data yet.</Empty>
      ) : (
        <>
          <p>
            Overall: <Badge kind={health.status} data-testid="health-status">{health.status}</Badge>{' '}
            Test app: <span data-testid="health-reachable">{health.testApp.reachable ? 'reachable' : 'unreachable'}</span>
            {health.testApp.httpStatus !== null && health.testApp.httpStatus !== undefined
              ? <span data-testid="health-http"> (HTTP {health.testApp.httpStatus})</span> : null}
            {health.testApp.error ? <span className="muted"> {health.testApp.error}</span> : null}
          </p>
          <p>
            Storage:{' '}
            <span data-testid="health-storage">
              {health.storage?.ok === false ? `error${health.storage.error ? `: ${health.storage.error}` : ''}` : health.storage?.ok === true ? 'ok' : 'unknown'}
            </span>
          </p>
          {health.testApp.components && typeof health.testApp.components === 'object' ? (
            <ul className="plain health-list" data-testid="health-components">
              {Object.entries(health.testApp.components).map(([name, value]) => (
                <li key={name} data-testid="health-component" data-component={name}>
                  <strong>{name}</strong>: <span>{show(value)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty testId="health-components-null">Component health is not available.</Empty>
          )}
        </>
      )}
      {idleNote ? <p className="muted">{idleNote}</p> : null}
    </section>
  );
}
