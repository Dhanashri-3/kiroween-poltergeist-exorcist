import skullUrl from '../../assets/specterops/skull.png';
import skullLitUrl from '../../assets/specterops/skull-lit.png';
import handUrl from '../../assets/specterops/hand.png';

/**
 * Skull resting on the graveyard horizon, with the skeletal hand rising to cradle it. `caught` comes from
 * an IntersectionObserver in the shell (the hero has started to scroll away); it is a class toggle, so
 * reduced motion simply shows the end state without a transition. The lit skull also ignites on hover.
 * Purely decorative: the whole group is hidden from assistive technology.
 */
export default function SkullHand({ caught = false }) {
  return (
    <div className={`so-skullhand${caught ? ' so-skullhand--caught' : ''}`} aria-hidden="true" data-testid="so-skullhand">
      <div className="so-skullhand__hand">
        <img src={handUrl} alt="" draggable="false" decoding="async" loading="lazy" className="so-skullhand__hand-img" />
        <div className="so-skullhand__shadow" />
      </div>
      <div className="so-skullhand__skull">
        <div className="so-skullhand__aura" />
        <img src={skullUrl} alt="" draggable="false" decoding="async" className="so-skullhand__skull-img" />
        <img src={skullLitUrl} alt="" draggable="false" decoding="async" loading="lazy" className="so-skullhand__skull-lit" />
      </div>
    </div>
  );
}
