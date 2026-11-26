import { useId, useState } from 'react';
import { Icon } from './icons.jsx';

const TAG_CLASS = { POLTERGEIST: 'poltergeist', EXORCIST: 'exorcist', SYSTEM: 'system' };
export const EXPANDED_LINES = 8;

/**
 * Frosted agent activity pill, docked bottom-centre. Collapsed it shows the newest line; expanded, the
 * newest EXPANDED_LINES. Lines come from buildLogLines() (genuine Events and client notes only).
 *
 * Accessibility: the list is role="log" named "Agent activity" and stays in the DOM in every state, so new
 * lines are still announced. The toggle has aria-expanded / aria-controls. The dock itself ignores the
 * pointer; only the pill accepts clicks.
 *
 * Below 480 px (log.css) the collapsed pill becomes a 44 px icon button docked bottom-right, with a pip in the
 * newest line's actor colour. The collapsed log text is then visually hidden but still announced; expanding
 * shows the full history inside the viewport margins.
 */
export default function AgentLogPill({ lines = [], defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  const list = Array.isArray(lines) ? lines : [];
  const visible = open ? list.slice(-EXPANDED_LINES) : list.slice(-1);
  const latest = list.length > 0 ? list[list.length - 1] : null;
  return (
    <div className="so-logdock">
      <div className={`so-log${open ? ' so-log--open' : ''}`}>
        <Icon name="terminal" className="so-icon so-log__icon" />
        <ol id={listId} className="so-log__list" role="log" aria-label="Agent activity" aria-live="polite"
          tabIndex={open ? 0 : undefined}>
          {visible.length === 0 ? <li className="so-log__empty">No agent activity yet.</li> : visible.map((line) => (
            <li key={line.key} className={`so-log__line${line.live ? ' so-log__line--live' : ''}`}
              data-testid="so-log-line" data-actor={line.actor} data-seq={line.seq ?? undefined}>
              <span className={`so-log__tag so-log__tag--${TAG_CLASS[line.actor] ?? 'system'}`}>[{line.actor}]</span>
              {' '}<span className="so-log__text">{line.text}</span>
            </li>
          ))}
        </ol>
        <button type="button" className="so-iconbtn so-log__toggle" aria-expanded={open} aria-controls={listId}
          aria-label={open ? 'Hide agent activity history' : 'Show agent activity history'}
          onClick={() => setOpen((v) => !v)}>
          <Icon name={open ? 'chevronDown' : 'chevronUp'} className="so-icon so-log__chevron" />
          <Icon name="terminal" className="so-icon so-log__compact-icon" />
          {/* Compact mode only: colour of the newest line's actor; amber for a client-side note. */}
          {latest ? <span className="so-log__pip" aria-hidden="true" data-testid="so-log-pip"
            data-actor={latest.actor} data-source={latest.source} /> : null}
        </button>
      </div>
    </div>
  );
}
