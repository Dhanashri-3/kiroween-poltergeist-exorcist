import { useEffect, useRef } from 'react';
import { createCueTracker } from '../soundCues.js';

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Plays sound cues for genuine live Events (Phase 4B.4B). Opens no stream and fetches nothing: it reads the
 * reducer timeline, the history watermark and the reducer's outcome selector, exactly like deriveLiveEffects.
 *
 *   events      state.events (validated, unique by seq)
 *   watermark   useHistoryWatermark result; null = nothing is live
 *   outcomeFor  (incidentId) => selectIncidentOutcome(state, incidentId)
 *   engine      createSoundEngine() instance (play)
 *   enabled     the user turned sound on and the engine unlocked
 *
 * Events seen while disabled or while the tab is hidden are consumed and never played later. Going muted or
 * hidden discards any recovery cue still waiting for its verification. The tracker lives in a ref, so a
 * StrictMode effect re-run finds every seq already handled and plays nothing twice.
 */
export function useSoundCues({ events, watermark = null, outcomeFor, engine, enabled = false } = {}) {
  const trackerRef = useRef(null);
  if (trackerRef.current === null) trackerRef.current = createCueTracker();

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
    const onVisibility = () => { if (isHidden()) trackerRef.current.discardPending(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    const canPlay = enabled === true && !isHidden() && engine != null && typeof engine.play === 'function';
    const cues = trackerRef.current.next({ events, watermark, outcomeFor, canPlay });
    if (!canPlay) return;
    for (const { cue } of cues) engine.play(cue);
  }, [events, watermark, outcomeFor, engine, enabled]);
}

export default useSoundCues;
