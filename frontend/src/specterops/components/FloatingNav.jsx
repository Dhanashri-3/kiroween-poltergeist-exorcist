import ThemeToggle from './ThemeToggle.jsx';
import SummonControl from './SummonControl.jsx';

const LINKS = [
  ['Overview', 'so-overview'],
  ['Defense Mesh', 'so-defense-mesh'],
  ['Dashboard', 'so-dashboard'],
];

/** Same wording as the existing ConnectionStatus component. Unknown values show nothing. */
const STREAM_LABELS = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Disconnected',
  closed: 'Closed',
};

/**
 * Pill navigation. Section links are plain anchors (user-initiated scrolling only). The stream chip shows
 * the genuine connection status passed in and is hidden when none is passed. It is not a live region: the
 * Dashboard's ConnectionStatus already announces changes.
 */
export default function FloatingNav({ theme, onToggleTheme, connectionStatus, summon = {} }) {
  const stream = STREAM_LABELS[connectionStatus] ?? null;
  return (
    <nav className="so-nav" aria-label="SpecterOps">
      <a className="so-nav__brand" href="#so-overview">SPECTEROPS</a>
      <ul className="so-nav__links">
        {LINKS.map(([label, id]) => (
          <li key={id}><a className="so-nav__link" href={`#${id}`}>{label}</a></li>
        ))}
      </ul>
      {stream ? (
        <span className={`so-nav__stream so-nav__stream--${connectionStatus}`} data-testid="so-stream-chip">
          <span className="so-dot" aria-hidden="true" />Stream {stream}
        </span>
      ) : null}
      <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      <SummonControl {...summon} />
    </nav>
  );
}
