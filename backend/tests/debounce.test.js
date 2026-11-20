import { describe, it, expect } from 'vitest';
import { step, createWindow } from '../src/monitor/debounce.js';

function run(results, incidentOpen = () => false) {
  let w = createWindow();
  return results.map((r, i) => {
    const out = step(w, r, incidentOpen(i));
    w = out.window;
    return out.emit.map((e) => e.type + (e.kind ? ':' + e.kind : ''));
  });
}

describe('monitor debounce step', () => {
  it('emits nothing for passes only', () => {
    expect(run(['pass', 'pass', 'pass', 'pass']).flat()).toEqual([]);
  });

  it('detects on exactly two consecutive failures, once per streak', () => {
    expect(run(['fail', 'fail', 'fail'])).toEqual([[], ['detection:failure'], []]);
  });

  it('emits transient for a single failure followed by a pass, no detection', () => {
    expect(run(['fail', 'pass'])).toEqual([[], ['transient']]);
  });

  it('emits availability detection whenever the app is unreachable', () => {
    expect(run(['unreachable', 'unreachable'])).toEqual([['detection:availability'], ['detection:availability']]);
  });

  it('does not emit transient after a single unreachable result', () => {
    expect(run(['unreachable', 'pass']).flat()).toEqual(['detection:availability']);
  });

  it('emits cleared after two passes following a detected failure', () => {
    expect(run(['fail', 'fail', 'pass', 'pass'])).toEqual([[], ['detection:failure'], [], ['cleared']]);
  });

  it('withholds cleared while an incident is open, then emits once when it closes', () => {
    const open = (i) => i < 5;
    const out = run(['fail', 'fail', 'pass', 'pass', 'pass', 'pass', 'pass'], open);
    expect(out[3]).not.toContain('cleared');
    expect(out[4]).not.toContain('cleared');
    expect(out[5]).toEqual(['cleared']);
    expect(out[6]).toEqual([]);
    expect(out.flat().filter((t) => t === 'cleared')).toHaveLength(1);
  });

  it('a failure between passes restarts the clearing count', () => {
    expect(run(['fail', 'fail', 'pass', 'fail', 'pass', 'pass'])[5]).toEqual(['cleared']);
  });

  it('emits recovery confirmation on the third consecutive pass after a failure', () => {
    const out = run(['fail', 'fail', 'pass', 'pass', 'pass', 'pass']);
    expect(out[4]).toEqual(['recovery_confirmed']);
    expect(out[5]).toEqual([]);
  });

  it('does not mutate the input window', () => {
    const w = createWindow();
    const snapshot = JSON.stringify(w);
    step(w, 'fail', false);
    expect(JSON.stringify(w)).toBe(snapshot);
  });

  it('rejects invalid results', () => {
    expect(() => step(createWindow(), 'bogus', false)).toThrow(TypeError);
  });
});
