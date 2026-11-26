import { forwardRef, useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { CrackOverlay, Glitch, HealPulse, SlashFlash } from './effects.jsx';

/**
 * One Defense Mesh card. `view` is one entry of deriveMeshView().cards; nothing here computes a status.
 *   slash          true while a live plasma strike hits this card
 *   heal           true while a live verified-recovery pulse plays (ignored unless view.verified)
 *   animateChanges when true, damage that appears from now on draws its cracks; damage already present
 *                  when this becomes true (history) renders in steady state
 */
const MeshCard = forwardRef(function MeshCard({ view, slash = false, heal = false, animateChanges = false, mirror = false }, ref) {
  const [drawToken, setDrawToken] = useState(0);
  const wasDamaged = useRef(view.damaged);
  useEffect(() => {
    if (view.damaged && !wasDamaged.current && animateChanges) setDrawToken((t) => t + 1);
    wasDamaged.current = view.damaged;
  }, [view.damaged, animateChanges]);

  const h = view.health;
  const headingId = `so-card-${view.key}-h`;
  // Alternating a/b class names restart the one-shot jitter and glitch animations for each live hit.
  const struck = view.damaged && drawToken > 0 ? ` so-card--struck-${drawToken % 2 ? 'a' : 'b'}` : '';
  return (
    <article ref={ref} className={`so-card so-card--${view.badge.tone}${view.damaged ? ' so-card--damaged' : ''}${struck}`}
      aria-labelledby={headingId} data-testid="so-card" data-key={view.key} data-health={h.state}>
      <div className="so-card__sheen" aria-hidden="true" />
      <div className="so-card__body">
        <div className="so-card__top">
          <span className="so-card__code">{view.code}</span>
          <Icon name={view.icon} className="so-icon so-card__icon" />
        </div>
        <h3 id={headingId} className="so-card__title">
          <Glitch active={view.damaged}>{view.name}</Glitch>
        </h3>
        <p className="so-card__badge" data-testid="so-card-badge" data-tone={view.badge.tone}>
          <span className="so-dot" aria-hidden="true" />
          <Glitch active={view.badge.tone === 'breached'}>{view.badge.text}</Glitch>
        </p>
        <dl className="so-card__facts">
          <div><dt>Check</dt><dd><code>{view.key}</code></dd></div>
          <div>
            <dt>Health</dt>
            <dd data-testid="so-card-health">{h.status ?? <span className="so-muted">{h.note}</span>}</dd>
          </div>
          {h.error ? <div><dt>Error</dt><dd className="so-card__error" data-testid="so-card-error">{h.error}</dd></div> : null}
          <div>
            <dt>Incident</dt>
            <dd data-testid="so-card-incident">
              {view.incident
                ? <><code>{view.incident.incidentId}</code> <span className="so-muted">{view.incident.label}</span></>
                : <span className="so-muted">None</span>}
            </dd>
          </div>
        </dl>
      </div>
      {view.damaged ? <CrackOverlay key={drawToken} mirror={mirror} draw={drawToken > 0} /> : null}
      {slash ? <SlashFlash /> : null}
      {heal && view.verified ? <HealPulse /> : null}
    </article>
  );
});

export default MeshCard;
