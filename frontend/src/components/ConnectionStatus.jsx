import './common.jsx';

const LABELS = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Disconnected (reconnecting)',
  closed: 'Closed',
};

export default function ConnectionStatus({ status, error, lastSeq }) {
  const known = status in LABELS ? status : 'connecting';
  return (
    <div data-testid="connection">
      <div role="status" aria-live="polite" data-testid="connection-status" data-status={known}
        className={`connection connection--${known}`}>
        Event stream: <strong>{LABELS[known]}</strong>
        {typeof lastSeq === 'number' ? <span className="muted"> (last seq {lastSeq})</span> : null}
      </div>
      {error ? <div role="alert" className="alert" data-testid="connection-error">{error}</div> : null}
    </div>
  );
}
