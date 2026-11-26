import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import graveyardUrl from '../../assets/specterops/graveyard-keyed.webp';
import { deriveMeshView } from '../state/meshView.js';
import { useReducedMotion } from '../hooks/useReducedMotion.js';
import MeshCard from './MeshCard.jsx';
import AppLevelIncidents from './AppLevelIncidents.jsx';
import Reaper, { REAPER_TIP } from './Reaper.jsx';
import PlasmaBeam from './PlasmaBeam.jsx';

export const STRIKE_TIMING = Object.freeze({ charge: 900, fire: 1150, hold: 1650 });
export const HEAL_MS = 1200;

const tokenOf = (effect) => (effect && typeof effect.targetKey === 'string' ? `${effect.targetKey}:${effect.token}` : null);

/** Strike phases for one genuine live strike. Reduced motion jumps straight to the resting 'hold' phase. */
function useStrikePhase(token, reducedMotion) {
  const [phase, setPhase] = useState(null);
  useEffect(() => {
    if (token === null) { setPhase(null); return undefined; }
    if (reducedMotion) { setPhase('hold'); return undefined; }
    setPhase('arrive');
    const timers = [
      setTimeout(() => setPhase('charge'), STRIKE_TIMING.charge),
      setTimeout(() => setPhase('fire'), STRIKE_TIMING.fire),
      setTimeout(() => setPhase('hold'), STRIKE_TIMING.hold),
    ];
    return () => timers.forEach(clearTimeout);
  }, [token, reducedMotion]);
  return phase;
}

/** Card key whose heal pulse is playing, for HEAL_MS after a new heal token. None under reduced motion. */
function useHealPulse(token, reducedMotion) {
  const [key, setKey] = useState(null);
  useEffect(() => {
    if (token === null || reducedMotion) { setKey(null); return undefined; }
    setKey(token.slice(0, token.lastIndexOf(':')));
    const timer = setTimeout(() => setKey(null), HEAL_MS);
    return () => clearTimeout(timer);
  }, [token, reducedMotion]);
  return key;
}

/**
 * Beam geometry in the coordinates of the mesh's inner box. The reaper stays in its lane (a decorative region
 * outside every card); only the short-lived beam crosses to the target, ending at the card's top edge.
 */
function measure(inner, lane, card) {
  const i = inner.getBoundingClientRect();
  const l = lane.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const laneLeft = l.left - i.left;
  const laneTop = l.top - i.top;
  const target = { x: c.left - i.left + c.width / 2, y: c.top - i.top };
  const flip = target.x < laneLeft + l.width / 2; // face the target
  const from = { x: laneLeft + l.width * (flip ? 1 - REAPER_TIP.x : REAPER_TIP.x), y: laneTop + l.height * REAPER_TIP.y };
  return { flip, from, to: target };
}

/**
 * Defense Mesh: the four health-check cards in a 2x2 grid, app-level Incidents, and the reaper lane.
 *
 * Props (all genuine data, supplied by the caller):
 *   health, incidents   see deriveMeshView
 *   strike, heal        see deriveLiveEffects. null = no effect. The reaper exists only while strike is set.
 *   animateChanges      true once live Events are flowing; damage already present renders in steady state
 */
export default function DefenseMesh({ health = null, incidents = [], strike = null, heal = null, animateChanges = false }) {
  const reducedMotion = useReducedMotion();
  const view = useMemo(() => deriveMeshView({ health, incidents }), [health, incidents]);
  const innerRef = useRef(null);
  const laneRef = useRef(null);
  const cardRefs = useRef({});

  const strikeToken = tokenOf(strike);
  const phase = useStrikePhase(strikeToken, reducedMotion);
  const healKey = useHealPulse(tokenOf(heal), reducedMotion);
  const [geometry, setGeometry] = useState(null);

  useLayoutEffect(() => {
    if (strikeToken === null) { setGeometry(null); return undefined; }
    const update = () => {
      const inner = innerRef.current;
      const lane = laneRef.current;
      const card = cardRefs.current[strike.targetKey];
      setGeometry(inner && lane && card ? measure(inner, lane, card) : null);
    };
    update();
    window.addEventListener('resize', update, { passive: true });
    return () => window.removeEventListener('resize', update);
    // strikeToken encodes strike.targetKey and strike.token
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strikeToken]);

  const target = strike?.targetKey ?? null;
  const showReaper = strikeToken !== null && phase !== null;
  const firing = showReaper && geometry !== null && phase === 'fire' && !reducedMotion;

  return (
    <section id="so-defense-mesh" className="so-mesh" aria-labelledby="so-mesh-h">
      <div className="so-mesh__backdrop" aria-hidden="true">
        <img src={graveyardUrl} alt="" draggable="false" decoding="async" loading="lazy" className="so-mesh__crypt" />
      </div>
      <div className="so-mesh__inner" ref={innerRef}>
        {/* Reaper lane: decorative region beside the heading, reserved so the reaper never covers a card. */}
        <div className="so-mesh__lane" ref={laneRef} aria-hidden="true" data-testid="so-reaper-lane">
          {showReaper ? <Reaper flip={geometry?.flip ?? true} phase={phase} /> : null}
        </div>
        <div className="so-mesh__head">
          <p className="so-mesh__eyebrow">Self Healing</p>
          <h2 id="so-mesh-h" className="so-mesh__title">Defense Mesh</h2>
          <p className="so-mesh__lede">
            Each card shows one Test_App health check as the backend last reported it, with the newest Incident
            for that check. Nothing here is estimated.
          </p>
        </div>
        <div className="so-mesh__field">
          <div className="so-mesh__grid">
            {view.cards.map((card, index) => (
              <MeshCard key={card.key} view={card} mirror={index % 2 === 1} animateChanges={animateChanges}
                slash={firing && target === card.key} heal={healKey === card.key}
                ref={(el) => { cardRefs.current[card.key] = el; }} />
            ))}
          </div>
        </div>
        <AppLevelIncidents items={view.appLevel} />
        {firing ? <PlasmaBeam from={geometry.from} to={geometry.to} seed={Number(strike.token) || 1} /> : null}
      </div>
    </section>
  );
}
