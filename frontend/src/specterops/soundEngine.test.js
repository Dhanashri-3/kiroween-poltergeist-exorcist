/**
 * Phase 4B.4B: sound engine with an injected fake AudioContext. Nothing here plays real audio.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createSoundEngine, getAudioContextImpl, CUE_DEFINITIONS, CUE_NAMES, MASTER_GAIN, MAX_VOICES, MIN_REPEAT_MS,
} from './soundEngine.js';

class FakeParam {
  constructor(value = 0) { this.value = value; this.calls = []; }
  setValueAtTime(v, t) { this.value = v; this.calls.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.calls.push(['linear', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.calls.push(['exp', v, t]); return this; }
  cancelScheduledValues(t) { this.calls.push(['cancel', t]); return this; }
}
class FakeNode {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outputs = []; this.disconnected = 0; }
  connect(node) { this.outputs.push(node); return node; }
  disconnect() { this.disconnected += 1; }
}
class FakeSource extends FakeNode {
  constructor(ctx, kind) { super(ctx, kind); this.started = null; this.stops = []; this.onended = null; }
  start(t) { this.started = t; }
  stop(t) { this.stops.push(t); }
  end() { this.onended?.(); }
}

/** A fake AudioContext class. resume: 'run' (default), 'reject' or 'stay' (resolves but stays suspended). */
function fakeAudio({ resume = 'run', throwOnCreate = false } = {}) {
  class FakeAudioContext {
    static instances = [];
    constructor() {
      if (throwOnCreate) throw new Error('no audio device');
      this.state = 'suspended';
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.destination = new FakeNode(this, 'destination');
      this.created = [];
      this.calls = { resume: 0, suspend: 0, close: 0 };
      FakeAudioContext.instances.push(this);
    }
    track(node) { this.created.push(node); return node; }
    createGain() { const n = new FakeNode(this, 'gain'); n.gain = new FakeParam(1); return this.track(n); }
    createOscillator() {
      const n = new FakeSource(this, 'oscillator');
      n.type = 'sine'; n.frequency = new FakeParam(440); n.detune = new FakeParam(0);
      return this.track(n);
    }
    createBiquadFilter() {
      const n = new FakeNode(this, 'filter');
      n.type = 'lowpass'; n.frequency = new FakeParam(350); n.Q = new FakeParam(1);
      return this.track(n);
    }
    createBufferSource() { const n = new FakeSource(this, 'buffer'); n.buffer = null; return this.track(n); }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { numberOfChannels: channels, length, sampleRate: rate, getChannelData: () => data };
    }
    resume() {
      this.calls.resume += 1;
      if (resume === 'reject') return Promise.reject(new Error('not allowed'));
      if (resume === 'run') this.state = 'running';
      return Promise.resolve();
    }
    suspend() { this.calls.suspend += 1; this.state = 'suspended'; return Promise.resolve(); }
    close() { this.calls.close += 1; this.state = 'closed'; return Promise.resolve(); }
    sources() { return this.created.filter((n) => n instanceof FakeSource); }
    master() { return this.created[0]; }
  }
  return FakeAudioContext;
}

const clock = () => {
  let t = 0;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
};

describe('getAudioContextImpl', () => {
  it('prefers AudioContext, falls back to webkitAudioContext, else null', () => {
    const A = function A() {};
    const W = function W() {};
    expect(getAudioContextImpl({ AudioContext: A, webkitAudioContext: W })).toBe(A);
    expect(getAudioContextImpl({ webkitAudioContext: W })).toBe(W);
    expect(getAudioContextImpl({})).toBeNull();
    expect(getAudioContextImpl(null)).toBeNull();
  });
});

describe('sound engine: creation and unlock', () => {
  it('creates no AudioContext until unlock() and plays nothing before it', () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake });
    expect(engine.available()).toBe(true);
    expect(engine.isEnabled()).toBe(false);
    expect(engine.play('poltergeist')).toBe(false);
    expect(Fake.instances).toHaveLength(0);
  });

  it('unlock() creates one context, resumes it synchronously and opens the master gain at a restrained level', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake });
    const pending = engine.unlock();
    expect(Fake.instances).toHaveLength(1); // constructed before the first await: still inside the gesture
    expect(Fake.instances[0].calls.resume).toBe(1);
    await expect(pending).resolves.toEqual({ ok: true });
    const ctx = Fake.instances[0];
    expect(ctx.master().kind).toBe('gain');
    expect(ctx.master().outputs).toContain(ctx.destination);
    expect(ctx.master().gain.value).toBe(MASTER_GAIN);
    expect(MASTER_GAIN).toBeGreaterThanOrEqual(0.15);
    expect(MASTER_GAIN).toBeLessThanOrEqual(0.2);
    expect(engine.isEnabled()).toBe(true);
  });

  it('reports unavailable without a Web Audio constructor', async () => {
    const engine = createSoundEngine({ AudioContextImpl: null });
    expect(engine.available()).toBe(false);
    await expect(engine.unlock()).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(engine.play('diagnose')).toBe(false);
  });

  it('stays muted when the constructor throws, and keeps no context', async () => {
    const Fake = fakeAudio({ throwOnCreate: true });
    const engine = createSoundEngine({ AudioContextImpl: Fake });
    await expect(engine.unlock()).resolves.toEqual({ ok: false, reason: 'error' });
    expect(engine.isEnabled()).toBe(false);
    expect(engine.play('diagnose')).toBe(false);
  });

  it('stays muted when resume() is rejected or the context stays suspended', async () => {
    for (const resume of ['reject', 'stay']) {
      const Fake = fakeAudio({ resume });
      const engine = createSoundEngine({ AudioContextImpl: Fake });
      await expect(engine.unlock()).resolves.toEqual({ ok: false, reason: 'blocked' });
      expect(engine.isEnabled()).toBe(false);
      expect(engine.play('diagnose')).toBe(false);
      expect(Fake.instances[0].sources()).toHaveLength(0);
    }
  });

  it('a mute during a pending unlock cancels it', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake });
    const pending = engine.unlock();
    engine.mute();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(engine.isEnabled()).toBe(false);
  });
});

describe('sound engine: a failed resume releases the context (Phase 4B.4C.1)', () => {
  const allowResume = function resume() { this.calls.resume += 1; this.state = 'running'; return Promise.resolve(); };
  const refuseResume = function resume() { this.calls.resume += 1; return Promise.reject(new Error('not allowed')); };

  async function expectReleased(resume) {
    const Fake = fakeAudio({ resume });
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await expect(engine.unlock()).resolves.toEqual({ ok: false, reason: 'blocked' });
    const ctx = Fake.instances[0];
    expect(ctx.calls.close).toBe(1);
    expect(ctx.state).toBe('closed');
    expect(ctx.master().gain.value).toBe(0);
    expect(ctx.master().disconnected).toBeGreaterThan(0);
    expect(engine.isEnabled()).toBe(false);
    expect(engine.play('diagnose')).toBe(false);
    expect(ctx.sources()).toHaveLength(0);
  }

  it('closes and drops the context when resume() is rejected', () => expectReleased('reject'));

  it('closes and drops the context when resume() leaves it suspended', () => expectReleased('stay'));

  it('a later click builds a fresh usable context and never touches the released one', async () => {
    const Fake = fakeAudio({ resume: 'reject' });
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await engine.unlock();
    const released = Fake.instances[0];
    Fake.prototype.resume = allowResume; // the browser now allows audio
    await expect(engine.unlock()).resolves.toEqual({ ok: true });
    expect(Fake.instances).toHaveLength(2);
    const fresh = Fake.instances[1];
    expect(fresh.state).toBe('running');
    expect(fresh.master().gain.value).toBe(MASTER_GAIN);
    expect(engine.play('diagnose')).toBe(true);
    expect(fresh.sources()).toHaveLength(CUE_DEFINITIONS.diagnose.length);
    expect(released.sources()).toHaveLength(0);
    expect(released.calls.resume).toBe(1);
  });

  it('a refused re-enable after mute stops every sound, releases that context, and the next click recovers', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await engine.unlock();
    engine.play('poltergeist');
    const first = Fake.instances[0];
    const sources = first.sources();
    engine.mute();
    Fake.prototype.resume = refuseResume;
    await expect(engine.unlock()).resolves.toEqual({ ok: false, reason: 'blocked' });
    expect(first.state).toBe('closed');
    for (const s of sources) expect(s.disconnected).toBeGreaterThan(0);
    expect(engine.activeVoices()).toBe(0);
    expect(engine.isEnabled()).toBe(false);
    Fake.prototype.resume = allowResume;
    await expect(engine.unlock()).resolves.toEqual({ ok: true });
    expect(Fake.instances).toHaveLength(2);
    expect(engine.play('diagnose')).toBe(true); // a different cue: 'poltergeist' is still inside MIN_REPEAT_MS
  });
});

describe('sound engine: cues', () => {
  it('defines every cue from oscillators or noise only, each shorter than one second', () => {
    expect(CUE_NAMES).toEqual(expect.arrayContaining([
      'poltergeist', 'diagnose', 'repair-start', 'repair-done', 'verify-pass', 'verify-fail', 'rollback', 'escalate', 'recovered',
    ]));
    for (const name of CUE_NAMES) {
      for (const p of CUE_DEFINITIONS[name]) {
        expect(p.at + p.dur, name).toBeLessThan(1);
        expect(p.noise === true || ['sine', 'triangle', 'square', 'sawtooth'].includes(p.type), name).toBe(true);
      }
    }
  });

  it('schedules a known cue through the master gain and ignores unknown cues', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await engine.unlock();
    const ctx = Fake.instances[0];
    expect(engine.play('not-a-cue')).toBe(false);
    expect(engine.play('recovered')).toBe(true);
    const oscillators = ctx.sources();
    expect(oscillators.map((o) => o.frequency.calls[0][1])).toEqual([523.25, 659.25, 783.99]);
    for (const o of oscillators) {
      expect(o.started).not.toBeNull();
      expect(o.stops.length).toBe(1);
    }
    expect(engine.play('repair-start')).toBe(true); // noise cue
    expect(ctx.sources().at(-1).kind).toBe('buffer');
  });

  it('blocks a repeated cue burst within MIN_REPEAT_MS', async () => {
    const Fake = fakeAudio();
    const now = clock();
    const engine = createSoundEngine({ AudioContextImpl: Fake, now });
    await engine.unlock();
    expect(engine.play('diagnose')).toBe(true);
    expect(engine.play('diagnose')).toBe(false);
    now.advance(MIN_REPEAT_MS);
    expect(engine.play('diagnose')).toBe(true);
  });

  it('limits concurrent voices and frees a voice when its sounds end', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await engine.unlock();
    const names = ['poltergeist', 'diagnose', 'repair-done', 'verify-pass', 'rollback'];
    const results = names.map((n) => engine.play(n));
    expect(results).toEqual([true, true, true, true, false]);
    expect(engine.activeVoices()).toBe(MAX_VOICES);
    const ctx = Fake.instances[0];
    for (const source of ctx.sources().filter((s) => s.frequency?.calls[0][1] === 784)) source.end(); // verify-pass
    expect(engine.activeVoices()).toBe(MAX_VOICES - 1);
    expect(engine.play('rollback')).toBe(true);
  });
});

describe('sound engine: mute, unmute and dispose', () => {
  it('mute() zeroes the master gain, stops active sounds and suspends', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await engine.unlock();
    engine.play('poltergeist');
    const ctx = Fake.instances[0];
    const sources = ctx.sources();
    engine.mute();
    expect(ctx.master().gain.value).toBe(0);
    for (const s of sources) {
      expect(s.stops.at(-1)).toBe(0);
      expect(s.disconnected).toBeGreaterThan(0);
    }
    expect(engine.activeVoices()).toBe(0);
    expect(ctx.calls.suspend).toBe(1);
    expect(engine.play('diagnose')).toBe(false);
  });

  it('unmuting needs another unlock(), which resumes the same, still open context', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await engine.unlock();
    engine.mute();
    expect(engine.play('diagnose')).toBe(false);
    await expect(engine.unlock()).resolves.toEqual({ ok: true });
    expect(Fake.instances).toHaveLength(1);
    expect(Fake.instances[0].calls.resume).toBe(2);
    expect(Fake.instances[0].master().gain.value).toBe(MASTER_GAIN);
    expect(engine.play('diagnose')).toBe(true);
  });

  it('dispose() closes the context and a later unlock() builds a fresh one', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await engine.unlock();
    engine.play('diagnose');
    engine.dispose();
    const first = Fake.instances[0];
    expect(first.calls.close).toBe(1);
    expect(engine.isEnabled()).toBe(false);
    expect(engine.play('diagnose')).toBe(false);
    await expect(engine.unlock()).resolves.toEqual({ ok: true });
    expect(Fake.instances).toHaveLength(2);
    expect(first.calls.resume).toBe(1); // the closed context was never touched again
    expect(engine.play('diagnose')).toBe(true);
    expect(first.sources()).toHaveLength(CUE_DEFINITIONS.diagnose.length); // nothing new on the closed context
  });

  it('replaces a context the browser closed instead of reusing it', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await engine.unlock();
    Fake.instances[0].state = 'closed';
    expect(engine.play('diagnose')).toBe(false);
    await expect(engine.unlock()).resolves.toEqual({ ok: true });
    expect(Fake.instances).toHaveLength(2);
  });

  it('dispose() without a context is safe and repeatable', () => {
    const engine = createSoundEngine({ AudioContextImpl: fakeAudio() });
    expect(() => { engine.dispose(); engine.dispose(); engine.mute(); }).not.toThrow();
  });

  it('never throws from play() when node creation fails', async () => {
    const Fake = fakeAudio();
    const engine = createSoundEngine({ AudioContextImpl: Fake, now: clock() });
    await engine.unlock();
    Fake.instances[0].createOscillator = vi.fn(() => { throw new Error('boom'); });
    expect(engine.play('diagnose')).toBe(false);
    expect(engine.activeVoices()).toBe(0);
  });
});
