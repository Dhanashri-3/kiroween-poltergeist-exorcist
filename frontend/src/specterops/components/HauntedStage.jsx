import { forwardRef } from 'react';
import graveyardUrl from '../../assets/specterops/graveyard-keyed.webp';
import SkullHand from './SkullHand.jsx';
import { BatIcon, Icon } from './icons.jsx';

/** z-10 translucent glass moon. Position follows --specterops-pointer-x (0 under reduced motion). */
function MoonLayer() {
  return (
    <div className="so-moon" aria-hidden="true">
      <div className="so-moon__anchor">
        <div className="so-moon__halo" />
        <div className="so-moon__body" />
        <div className="so-moon__rim" />
      </div>
    </div>
  );
}

/** z-15 three cloud bands drifting left to right (paused under reduced motion). */
function CloudLayer() {
  return (
    <div className="so-clouds" aria-hidden="true">
      <div className="so-clouds__band so-clouds__band--far" />
      <div className="so-clouds__band so-clouds__band--mid" />
      <div className="so-clouds__band so-clouds__band--near" />
    </div>
  );
}

/** z-20 graveyard horizon. The art spans two hero heights; only its surface half shows here. */
function GraveyardLayer() {
  return (
    <div className="so-graveyard" aria-hidden="true">
      <img src={graveyardUrl} alt="" draggable="false" decoding="async" className="so-graveyard__img" />
    </div>
  );
}

/**
 * Hero (banner landmark). Contains the nav, the layered haunted art, the SPECTEROPS wordmark, the skull and
 * the hero headline (an h2: the Dashboard owns the page's only h1).
 * Props: nav (element), caught (bool, from the shell's IntersectionObserver).
 */
const HauntedStage = forwardRef(function HauntedStage({ nav = null, caught = false }, ref) {
  return (
    <header ref={ref} id="so-overview" className="so-stage" aria-labelledby="so-hero-h">
      <div className="so-stage__art" aria-hidden="true">
        <div className="so-stage__backdrop" />
        <div className="so-wordmark"><span className="so-wordmark__text">SPECTEROPS</span></div>
        <MoonLayer />
        <CloudLayer />
        <GraveyardLayer />
        <div className="so-stage__vignette" />
      </div>
      {nav}
      <div className="so-stage__content">
        <SkullHand caught={caught} />
        <div className="so-hero">
          <h2 id="so-hero-h" className="so-hero__title">
            <span className="so-hero__line">Autonomous</span>{' '}
            <span className="so-hero__line so-hero__line--accent">Chaos Defense</span>
          </h2>
          <div className="so-hero__lede">
            <BatIcon />
            <p className="so-hero__text">
              Failures are injected, diagnosed and repaired by agents.
              {' '}Recovery is reported only after it is verified.
            </p>
          </div>
          <a className="so-hero__cta" href="#so-defense-mesh">
            Enter Defense Mesh <Icon name="arrowDown" />
          </a>
        </div>
      </div>
    </header>
  );
});

export default HauntedStage;
