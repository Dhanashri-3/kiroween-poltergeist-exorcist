import '../styles/dashboard.css';
import { omittedPayloadBytes } from '../state/dashboardViews.js';

/** Collapsed JSON view. Shows "payload omitted (N bytes)" for the documented {ref, bytes} form. */
export function PayloadView({ payload, label = 'payload' }) {
  const bytes = omittedPayloadBytes(payload);
  if (bytes !== null) {
    return <span data-testid="payload-omitted" className="muted">payload omitted ({bytes} bytes)</span>;
  }
  return (
    <details>
      <summary>{label}</summary>
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </details>
  );
}

export function Badge({ kind, children, ...rest }) {
  return <span className={`badge badge--${kind}`} {...rest}>{children}</span>;
}

export function Empty({ children, testId }) {
  return <p className="muted" data-testid={testId}>{children}</p>;
}
