/**
 * Inline SVG icons (no icon package). All are decorative: aria-hidden and not focusable.
 * Stroke icons follow a 24x24 grid; the bat silhouette is ported from web-ui/app/page.tsx.
 */
const STROKE = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75,
  strokeLinecap: 'round', strokeLinejoin: 'round',
};

const SHAPES = {
  cpu: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  speaker: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
    </>
  ),
  speakerOff: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </>
  ),
  terminal: <path d="M4 17l6-6-6-6M12 19h8" />,
  chevronUp: <path d="M18 15l-6-6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  arrowDown: <path d="M12 5v14M19 12l-7 7-7-7" />,
};

export function Icon({ name, className = 'so-icon' }) {
  const shape = SHAPES[name];
  if (!shape) return null;
  return (
    <svg {...STROKE} className={className} aria-hidden="true" focusable="false" data-icon={name}>
      {shape}
    </svg>
  );
}

export function BatIcon({ className = 'so-bat' }) {
  return (
    <svg viewBox="0 0 64 40" className={className} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M32 10 L35 4 L37 11 C42 9 48 6 56 8 C54 12 56 17 60 20 C54 19 50 20 47 24 C45 21 41 20 38 22 L36 30 L32 26 L28 30 L26 22 C23 20 19 21 17 24 C14 20 10 19 4 20 C8 17 10 12 8 8 C16 6 22 9 27 11 L29 4 Z" />
    </svg>
  );
}
