/**
 * Visual effects ported from web-ui/app/page.tsx to plain CSS animations (see styles/effects.css).
 * All are decorative and hidden from assistive technology. Every animation is disabled under reduced
 * motion; the resting state of each effect is its final frame, so nothing depends on the animation running.
 */

/** RGB-split glitch text (violet / cyan, never red). `active` turns it on. */
export function Glitch({ active, className = '', children }) {
  return <span className={`so-glitch${active ? ' so-glitch--active' : ''}${className ? ` ${className}` : ''}`}>{children}</span>;
}

const CRACKS = [
  'M55 45 L40 30 L32 12 L20 0',
  'M55 45 L72 28 L80 10 L90 0',
  'M55 45 L85 52 L100 48',
  'M55 45 L68 70 L62 85 L70 100',
  'M55 45 L35 62 L22 70 L0 82',
  'M55 45 L47 72 L50 100',
  'M40 30 L58 24 L72 28',
  'M35 62 L47 72 L68 70',
  'M32 12 L44 16',
  'M85 52 L92 70 L100 76',
  'M22 70 L14 52 L0 46',
];

/**
 * Cracked-glass overlay. `draw` plays the crack-draw animation (used only when damage appears live);
 * without it the cracks render fully drawn (steady state for history).
 */
export function CrackOverlay({ mirror = false, draw = false }) {
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"
      className={`so-crack${mirror ? ' so-crack--mirror' : ''}${draw ? ' so-crack--draw' : ''}`} data-testid="so-crack">
      <polygon points="55,45 40,30 72,28" className="so-crack__shard so-crack__shard--a" />
      <polygon points="55,45 85,52 68,70" className="so-crack__shard so-crack__shard--b" />
      <polygon points="55,45 35,62 47,72" className="so-crack__shard so-crack__shard--c" />
      <g className="so-crack__lines">
        {CRACKS.map((d, i) => (
          <g key={d} style={{ '--so-i': i }}>
            <path d={d} pathLength="1" className="so-crack__glow" vectorEffect="non-scaling-stroke" />
            <path d={d} pathLength="1" className="so-crack__core" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </g>
    </svg>
  );
}

/** Diagonal violet-cyan slash shown while the plasma beam strikes a card. */
export function SlashFlash() {
  const bolt = 'M2 4 L38 40 L28 46 L62 70 L54 74 L98 98';
  return (
    <div className="so-slash" aria-hidden="true" data-testid="so-slash">
      <div className="so-slash__flash" />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false" className="so-slash__svg">
        <path d={bolt} pathLength="1" className="so-slash__bolt" vectorEffect="non-scaling-stroke" />
        <path d={bolt} pathLength="1" className="so-slash__core" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/** Brief ice-cyan / emerald restorative flash on a card. */
export function HealPulse() {
  return <div className="so-heal" aria-hidden="true" data-testid="so-heal" />;
}
