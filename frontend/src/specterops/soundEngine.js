/**
 * SPECTEROPS sound engine (Phase 4B.4B). Framework-free Web Audio; no React, no samples, no network.
 *
 * Every cue is synthesized here from oscillators and a short noise burst. Nothing is downloaded.
 *
 * Lifecycle:
 *   - createSoundEngine() creates no AudioContext. The context is created only by unlock(), which the caller
 *     must invoke from the Sound toggle's click handler (a user gesture). unlock() constructs the context and
 *     calls resume() synchronously, before its first await, so the gesture is still active.
 *   - mute() silences at once: master gain to 0, every active sound stopped and disconnected, then suspend().
 *     Sound comes back only through another unlock(), that is another user gesture.
 *   - dispose() stops everything and closes the context. The engine stays reusable: a later unlock() builds a
 *     fresh context. A closed context is never kept as the active one.
 *   - play(cue) returns false (and does nothing) unless the engine is enabled and the context is running.
 *   - If resume() is rejected, or resolves without the context running, unlock() stays muted, stops every sound,
 *     closes that unusable context and drops the reference. The next click builds a fresh context.
 *
 * Limits: at most MAX_VOICES cues sound at once, and the same cue cannot restart within MIN_REPEAT_MS.
 */

export const MASTER_GAIN = 0.16;
export const MAX_VOICES = 4;
export const MIN_REPEAT_MS = 150;

const SILENT = 0.0001; // exponential ramps cannot reach 0
const ATTACK = 0.012;
const RELEASE_PAD = 0.03;

/**
 * Cue definitions. Each partial: { at, dur, gain, type, freq, to?, detune?, lowpass?, bandpass?, noise? }.
 * Times are seconds from the cue start; gain is relative to the master gain.
 */
export const CUE_DEFINITIONS = Object.freeze({
  // Poltergeist injection: descending, detuned, low-passed saw pair.
  poltergeist: [
    { at: 0, dur: 0.6, gain: 0.32, type: 'sawtooth', freq: 220, to: 110, lowpass: 900 },
    { at: 0, dur: 0.6, gain: 0.22, type: 'sawtooth', freq: 220, to: 110, detune: 14, lowpass: 900 },
  ],
  // Exorcist diagnosis: two soft scan blips.
  diagnose: [
    { at: 0, dur: 0.09, gain: 0.35, type: 'sine', freq: 660 },
    { at: 0.12, dur: 0.09, gain: 0.35, type: 'sine', freq: 880 },
  ],
  // incident.state -> repairing: a short filtered tick.
  'repair-start': [
    { at: 0, dur: 0.12, gain: 0.35, noise: true, bandpass: 2400 },
  ],
  // repair written: restrained rising pair.
  'repair-done': [
    { at: 0, dur: 0.14, gain: 0.4, type: 'triangle', freq: 440 },
    { at: 0.13, dur: 0.18, gain: 0.4, type: 'triangle', freq: 523.25 },
  ],
  // verification overall=pass: one neutral confirmation tone. Never the success chord.
  'verify-pass': [
    { at: 0, dur: 0.2, gain: 0.3, type: 'sine', freq: 784 },
  ],
  // verification failed: low, filtered warning.
  'verify-fail': [
    { at: 0, dur: 0.3, gain: 0.2, type: 'square', freq: 196, lowpass: 700 },
  ],
  // rollback: descending triangle.
  rollback: [
    { at: 0, dur: 0.4, gain: 0.35, type: 'triangle', freq: 392, to: 262 },
  ],
  // incident.state -> escalated: soft two-tone alternation.
  escalate: [
    { at: 0, dur: 0.14, gain: 0.28, type: 'triangle', freq: 330 },
    { at: 0.16, dur: 0.14, gain: 0.28, type: 'triangle', freq: 277 },
    { at: 0.32, dur: 0.14, gain: 0.28, type: 'triangle', freq: 330 },
    { at: 0.48, dur: 0.14, gain: 0.28, type: 'triangle', freq: 277 },
  ],
  // Verified recovery only: C5 E5 G5 arpeggio. The only success sound.
  recovered: [
    { at: 0, dur: 0.35, gain: 0.3, type: 'sine', freq: 523.25 },
    { at: 0.12, dur: 0.35, gain: 0.3, type: 'sine', freq: 659.25 },
    { at: 0.24, dur: 0.55, gain: 0.3, type: 'sine', freq: 783.99 },
  ],
});

export const CUE_NAMES = Object.freeze(Object.keys(CUE_DEFINITIONS));

/** The AudioContext constructor of `scope`, or null. Supports the prefixed webkitAudioContext (older Safari). */
export function getAudioContextImpl(scope = globalThis) {
  if (!scope) return null;
  if (typeof scope.AudioContext === 'function') return scope.AudioContext;
  if (typeof scope.webkitAudioContext === 'function') return scope.webkitAudioContext;
  const win = scope.window && scope.window !== scope ? scope.window : null;
  if (win && typeof win.AudioContext === 'function') return win.AudioContext;
  if (win && typeof win.webkitAudioContext === 'function') return win.webkitAudioContext;
  return null;
}

const quietly = (fn) => { try { return fn(); } catch { return undefined; } };
const settle = (p) => { if (p && typeof p.then === 'function') p.then(() => {}, () => {}); };

/**
 * Options (for tests): AudioContextImpl (a constructor, or null for "unsupported"; omitted = detect at unlock
 * time), now() in ms for the repeat limit.
 */
export function createSoundEngine(options = {}) {
  const hasImplOption = Object.prototype.hasOwnProperty.call(options, 'AudioContextImpl');
  const resolveImpl = () => (hasImplOption ? options.AudioContextImpl ?? null : getAudioContextImpl());
  const now = typeof options.now === 'function'
    ? options.now
    : () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let enabled = false;
  let generation = 0; // bumped by mute/dispose so a pending unlock cannot re-enable afterwards
  const voices = new Set();
  const lastStart = new Map();

  function stopVoice(voice) {
    voices.delete(voice);
    for (const source of voice.sources) {
      source.onended = null;
      quietly(() => source.stop(0));
    }
    for (const node of voice.nodes) quietly(() => node.disconnect());
  }

  function stopAll() {
    for (const voice of [...voices]) stopVoice(voice);
  }

  /** Drops voices whose sounds should have ended (onended can be missed). */
  function prune() {
    const t = ctx ? ctx.currentTime : 0;
    for (const voice of [...voices]) if (t > voice.endsAt + 0.5) stopVoice(voice);
  }

  function dropContext() {
    stopAll();
    if (master) quietly(() => master.disconnect());
    const old = ctx;
    ctx = null;
    master = null;
    noiseBuffer = null;
    if (old && old.state !== 'closed' && typeof old.close === 'function') settle(quietly(() => old.close()));
  }

  function silenceMaster() {
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    quietly(() => master.gain.cancelScheduledValues(t));
    quietly(() => master.gain.setValueAtTime(0, t));
    master.gain.value = 0;
  }

  function getNoise() {
    if (noiseBuffer) return noiseBuffer;
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.2));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    noiseBuffer = buffer;
    return buffer;
  }

  function buildPartial(voice, out, t0, p) {
    const start = t0 + p.at;
    const end = start + p.dur;
    let source;
    if (p.noise) {
      source = ctx.createBufferSource();
      source.buffer = getNoise();
    } else {
      source = ctx.createOscillator();
      source.type = p.type;
      source.frequency.setValueAtTime(p.freq, start);
      if (p.to) source.frequency.exponentialRampToValueAtTime(p.to, end);
      if (p.detune) source.detune.setValueAtTime(p.detune, start);
    }
    voice.nodes.push(source);
    let head = source;
    const filterFreq = p.lowpass ?? p.bandpass;
    if (filterFreq) {
      const filter = ctx.createBiquadFilter();
      filter.type = p.lowpass ? 'lowpass' : 'bandpass';
      filter.frequency.setValueAtTime(filterFreq, start);
      head.connect(filter);
      head = filter;
      voice.nodes.push(filter);
    }
    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENT, start);
    env.gain.exponentialRampToValueAtTime(p.gain, start + Math.min(ATTACK, p.dur / 2));
    env.gain.exponentialRampToValueAtTime(SILENT, end);
    head.connect(env);
    env.connect(out);
    voice.nodes.push(env);
    source.onended = () => {
      voice.pending -= 1;
      if (voice.pending <= 0) stopVoice(voice);
    };
    voice.sources.push(source);
    voice.pending += 1;
    source.start(start);
    source.stop(end + RELEASE_PAD);
    return end + RELEASE_PAD;
  }

  return Object.freeze({
    /** True when this environment has a Web Audio constructor. Does not create anything. */
    available() {
      return resolveImpl() !== null;
    },

    /** True when unlocked, not muted and the context is running. */
    isEnabled() {
      return enabled && ctx !== null && ctx.state === 'running';
    },

    /**
     * Call from a user gesture. Resolves { ok: true } or { ok: false, reason }, where reason is
     * 'unavailable' | 'error' | 'blocked' | 'cancelled'. On failure the engine stays muted.
     */
    async unlock() {
      const Impl = resolveImpl();
      if (!Impl) { enabled = false; return { ok: false, reason: 'unavailable' }; }
      generation += 1;
      const mine = generation;
      if (ctx && ctx.state === 'closed') dropContext(); // never reuse a closed context
      let resuming;
      try {
        if (!ctx) {
          ctx = new Impl();
          master = ctx.createGain();
          master.gain.setValueAtTime(0, ctx.currentTime);
          master.gain.value = 0;
          master.connect(ctx.destination);
        }
        resuming = typeof ctx.resume === 'function' ? ctx.resume() : undefined;
      } catch {
        dropContext();
        enabled = false;
        return { ok: false, reason: 'error' };
      }
      try {
        await resuming;
      } catch {
        if (mine !== generation) return { ok: false, reason: 'cancelled' };
        enabled = false;
        dropContext(); // the browser refused audio: release this context instead of leaving it open
        return { ok: false, reason: 'blocked' };
      }
      if (mine !== generation || !ctx) return { ok: false, reason: 'cancelled' };
      if (ctx.state !== 'running') {
        enabled = false;
        dropContext();
        return { ok: false, reason: 'blocked' };
      }
      const t = ctx.currentTime;
      quietly(() => master.gain.cancelScheduledValues(t));
      master.gain.setValueAtTime(MASTER_GAIN, t);
      master.gain.value = MASTER_GAIN;
      enabled = true;
      return { ok: true };
    },

    /** Silences immediately and suspends. Pending unlocks are cancelled. */
    mute() {
      generation += 1;
      enabled = false;
      silenceMaster();
      stopAll();
      if (ctx && ctx.state !== 'closed' && typeof ctx.suspend === 'function') settle(quietly(() => ctx.suspend()));
    },

    /** Plays one cue. Returns true when it was scheduled. */
    play(cue) {
      if (!enabled || !ctx || ctx.state !== 'running' || !master) return false;
      const definition = CUE_DEFINITIONS[cue];
      if (!definition) return false;
      prune();
      if (voices.size >= MAX_VOICES) return false;
      const at = now();
      const last = lastStart.get(cue);
      if (last !== undefined && at - last < MIN_REPEAT_MS) return false;
      const voice = { cue, sources: [], nodes: [], pending: 0, endsAt: 0 };
      try {
        const t0 = ctx.currentTime + 0.01;
        for (const partial of definition) voice.endsAt = Math.max(voice.endsAt, buildPartial(voice, master, t0, partial));
      } catch {
        stopVoice(voice);
        return false;
      }
      voices.add(voice);
      lastStart.set(cue, at);
      return true;
    },

    /** Active voice count (diagnostics and tests). */
    activeVoices() {
      return voices.size;
    },

    /** Stops everything and closes the context. A later unlock() creates a fresh one. */
    dispose() {
      generation += 1;
      enabled = false;
      silenceMaster();
      dropContext();
      lastStart.clear();
    },
  });
}

export default createSoundEngine;
