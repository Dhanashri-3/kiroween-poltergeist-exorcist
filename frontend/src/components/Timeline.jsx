import { Empty, PayloadView } from './common.jsx';

/** Props: events (ascending by seq, from selectTimeline or selectIncidentEvents). */
export default function Timeline({ events, title = 'Event timeline', testId = 'timeline' }) {
  return (
    <section className="panel" aria-labelledby={`${testId}-h`} data-testid={`${testId}-panel`}>
      <h2 id={`${testId}-h`}>{title}</h2>
      {events.length === 0 ? <Empty testId={`${testId}-empty`}>No events yet.</Empty> : (
        <ol className="plain timeline" role="log" aria-live="polite" aria-label={title} data-testid={testId}>
          {events.map((e) => (
            <li key={e.seq} data-testid="event-row" data-seq={e.seq} data-type={e.type}>
              <div className="row-meta mono">
                <span data-testid="event-seq">#{e.seq}</span>
                <strong data-testid="event-type">{e.type}</strong>
                <span data-testid="event-component">{e.component}</span>
                <time dateTime={e.ts} data-testid="event-ts">{e.ts}</time>
                <span data-testid="event-incident" className="muted">{e.incidentId ?? 'no incident'}</span>
              </div>
              <PayloadView payload={e.payload} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
