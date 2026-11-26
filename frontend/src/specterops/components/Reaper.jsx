import reaperUrl from '../../assets/specterops/reaper.png';

/** Scythe tip inside the reaper image, as a fraction of its box (from web-ui REAPER_TIP_PCT). */
export const REAPER_TIP = Object.freeze({ x: 0.76, y: 0.16 });

/**
 * The Poltergeist reaper. Rendered only while a genuine live strike exists (the caller decides), inside the
 * Defense Mesh reaper lane: a dedicated decorative region outside every card, so it never covers card content.
 * phase: 'arrive' | 'charge' | 'fire' | 'hold'. flip: face left (toward a target on its left).
 * Decorative: the agent log carries the information.
 */
export default function Reaper({ flip = false, phase = 'hold' }) {
  return (
    <div className={`so-reaper so-reaper--${phase}${flip ? ' so-reaper--flip' : ''}`} aria-hidden="true"
      data-testid="so-reaper" data-phase={phase}>
      <div className="so-reaper__float">
        <div className="so-reaper__body">
          <img src={reaperUrl} alt="" draggable="false" decoding="async" loading="lazy" className="so-reaper__img" />
          {phase === 'charge' ? <div className="so-reaper__charge" /> : null}
        </div>
      </div>
    </div>
  );
}
