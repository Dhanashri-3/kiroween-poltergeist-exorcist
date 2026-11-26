import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { reduce, initialState, selectHealth, selectIncidentIds, selectIncidentOutcome } from './state/dashboardReducer.js';
import { useEventStream } from './hooks/useEventStream.js';
import Dashboard from './components/Dashboard.jsx';
import { describeControlError } from './components/ScenarioControls.jsx';
import SpecterOpsShell from './specterops/SpecterOpsShell.jsx';
import { useSharedChaosGuard } from './specterops/hooks/useSharedChaosGuard.js';
import { useLiveRefresh } from './specterops/hooks/useLiveRefresh.js';
import { useHistoryWatermark } from './specterops/hooks/useHistoryWatermark.js';
import { buildLogLines } from './specterops/state/agentLog.js';
import { deriveLiveEffects } from './specterops/state/liveEffects.js';
import { createSoundEngine } from './specterops/soundEngine.js';
import { useSoundCues } from './specterops/hooks/useSoundCues.js';

export const SUMMON_IDLE_NOTICE = 'Summon starts a random scenario.';

/** Short explanations shown when sound cannot start. Sound stays off in every case. */
export const SOUND_NOTES = Object.freeze({
  unavailable: 'Sound is not supported in this browser.',
  blocked: 'The browser blocked audio. Sound stays off.',
  error: 'Audio could not start. Sound stays off.',
});
const SOUND_OFF = Object.freeze({ on: false, busy: false, note: null });
const MAX_CLIENT_NOTES = 20;
const NO_EVENTS = Object.freeze([]);

/** Incident summaries for the Defense Mesh, from reducer state only (API record component, reducer outcome). */
function selectShellIncidents(state) {
  const lastSeq = new Map();
  for (const e of state.events) if (e.incidentId !== null) lastSeq.set(e.incidentId, e.seq);
  return selectIncidentIds(state).map((incidentId) => ({
    incidentId,
    component: state.apiIncidents[incidentId]?.component ?? null, // null until the record is loaded: never guessed
    outcome: selectIncidentOutcome(state, incidentId),
    lastSeq: lastSeq.get(incidentId) ?? -1,
  }));
}

const runIdOf = (response) => (typeof response?.runId === 'string' && response.runId !== '' ? ` (runId ${response.runId})` : '');

export default function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const { status, error, lastSeq, startChaos, reset, history } = useEventStream({ dispatch });
  const connection = { status, error, lastSeq };
  // Live effects start only once validated history is loaded (Phase 4B.3C.3), not when the stream connects:
  // after a failed snapshot the stream replays the whole history right after `open`.
  const ready = history.ready;

  // One guard shared by the hero Summon control and the Dashboard ScenarioControls.
  const guarded = useSharedChaosGuard({ startChaos, reset });

  // Client-side refresh failures become SYSTEM notes placed after the newest Event seen at that moment.
  const [notes, setNotes] = useState([]);
  const eventsRef = useRef(state.events);
  eventsRef.current = state.events;
  const noteId = useRef(0);
  const pushClientNote = useCallback((kind, text) => {
    const events = eventsRef.current;
    const afterSeq = events.length > 0 ? events[events.length - 1].seq : -1;
    noteId.current += 1;
    const note = { id: `${kind}-${noteId.current}`, text, afterSeq };
    setNotes((list) => [...list, note].slice(-MAX_CLIENT_NOTES));
  }, []);
  const onRefreshError = useCallback((failure) => {
    pushClientNote('refresh', `Client-side: ${String(failure?.text ?? 'Live refresh failed.').replace(/^\[SYSTEM\]\s*/, '')}`);
  }, [pushClientNote]);

  // History notes: one when the retry budget is spent, one when history later loads. A ref deduplicates them
  // (repeated failed cycles add no new note) and survives StrictMode effect re-runs.
  const historyNote = useRef(null);
  useEffect(() => {
    if (history.status === 'unavailable' && historyNote.current !== 'unavailable') {
      historyNote.current = 'unavailable';
      pushClientNote('history', `Client-side: Event history could not be loaded after ${history.attempts} attempt${history.attempts === 1 ? '' : 's'}${history.error ? ` (${history.error})` : ''}. Live effects are paused until it loads.`);
    } else if (history.status === 'ready' && historyNote.current === 'unavailable') {
      historyNote.current = 'ready';
      pushClientNote('history', 'Client-side: Event history loaded. Live effects resumed.');
    }
  }, [history.status, history.attempts, history.error, pushClientNote]);

  useLiveRefresh({ state, dispatch, ready, onError: onRefreshError });

  // The watermark comes from the validated snapshot boundary (useEventStream), not from React state: the hook
  // fixes its mark from the last element of `events` the first time `ready` is true, so it gets the boundary.
  const boundaryEvents = useMemo(
    () => (history.ready ? [{ seq: history.boundarySeq }] : NO_EVENTS),
    [history.ready, history.boundarySeq],
  );
  const watermark = useHistoryWatermark({ events: boundaryEvents, ready });

  const incidents = useMemo(() => selectShellIncidents(state), [state]);
  const { strike, heal } = useMemo(
    () => deriveLiveEffects({ events: state.events, watermark, incidents }),
    [state.events, watermark, incidents],
  );
  const logLines = useMemo(
    () => buildLogLines({ events: state.events, notes, watermark, outcomeFor: (id) => selectIncidentOutcome(state, id) }),
    [state, notes, watermark],
  );

  // Summon: random scenario through the shared guard. Acceptance is only "request accepted", never an outcome.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [summonFeedback, setSummonFeedback] = useState({ notice: SUMMON_IDLE_NOTICE, error: null });
  const guardedStartChaos = guarded.startChaos;
  const onSummon = useCallback(() => {
    setSummonFeedback({ notice: SUMMON_IDLE_NOTICE, error: null });
    guardedStartChaos(undefined).then(
      (response) => {
        if (!mounted.current) return;
        setSummonFeedback({
          notice: `Chaos run request accepted${runIdOf(response)}. Random scenario; waiting for backend Events.`,
          error: null,
        });
      },
      (e) => {
        if (mounted.current) setSummonFeedback({ notice: null, error: describeControlError(e) });
      },
    );
  }, [guardedStartChaos]);

  // Sound (Phase 4B.4B): off on every load, never persisted. The engine object holds no AudioContext until the
  // Sound toggle is clicked; unmount (including StrictMode's simulated one) disposes it and turns sound off.
  const soundEngineRef = useRef(null);
  if (soundEngineRef.current === null) soundEngineRef.current = createSoundEngine();
  const soundEngine = soundEngineRef.current;
  const [sound, setSound] = useState(SOUND_OFF);
  const soundUnlocking = useRef(false);
  useEffect(() => () => {
    soundUnlocking.current = false;
    soundEngine.dispose();
    setSound(SOUND_OFF);
  }, [soundEngine]);
  const soundOn = sound.on;
  const onToggleSound = useCallback(() => {
    if (soundOn) {
      soundEngine.mute();
      setSound(SOUND_OFF);
      return;
    }
    if (soundUnlocking.current) return;
    soundUnlocking.current = true;
    setSound({ on: false, busy: true, note: null });
    // unlock() creates and resumes the AudioContext synchronously, inside this click.
    soundEngine.unlock().then((result) => {
      soundUnlocking.current = false;
      if (!mounted.current) return;
      if (result?.ok) setSound({ on: true, busy: false, note: null });
      else setSound({ on: false, busy: false, note: SOUND_NOTES[result?.reason] ?? null });
    });
  }, [soundOn, soundEngine]);
  const outcomeFor = useCallback((id) => selectIncidentOutcome(state, id), [state]);
  useSoundCues({ events: state.events, watermark, outcomeFor, engine: soundEngine, enabled: soundOn });

  return (
    <SpecterOpsShell
      connectionStatus={status}
      health={selectHealth(state)}
      incidents={incidents}
      strike={strike}
      heal={heal}
      animateChanges={watermark !== null}
      logLines={logLines}
      summon={{ onSummon, busy: guarded.busy, notice: summonFeedback.notice, error: summonFeedback.error }}
      sound={{ on: sound.on, busy: sound.busy, note: sound.note, available: soundEngine.available(), onToggle: onToggleSound }}
    >
      <Dashboard
        state={state}
        connection={connection}
        onStartChaos={guarded.startChaos}
        onReset={guarded.reset}
      />
    </SpecterOpsShell>
  );
}
