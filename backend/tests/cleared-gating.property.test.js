import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { step, createWindow } from '../src/monitor/debounce.js';

// Feature: poltergeist-exorcist-healing-system, Property 6: Cleared event gating
// **Validates: Requirements 5.6, 5.9**

const resultArb = fc.constantFrom('pass', 'fail', 'unreachable');
const stepArb = fc.record({ result: resultArb, open: fc.boolean() });

describe('Property 6: Cleared event gating', () => {
  it('emits cleared only after 2 consecutive passes following a failure and only while no open Incident references the check', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        let win = createWindow();
        let pending = false; // a failure occurred and cleared has not yet been emitted
        let passes = 0; // consecutive passes ending at the current result

        for (const { result, open } of steps) {
          const out = step(win, result, open);
          win = out.window;
          const cleared = out.emit.filter((e) => e.type === 'cleared');

          if (result === 'pass') {
            passes += 1;
            const shouldClear = pending && passes >= 2 && !open;
            expect(cleared).toHaveLength(shouldClear ? 1 : 0);
            if (shouldClear) pending = false;
          } else {
            passes = 0;
            pending = true;
            expect(cleared).toHaveLength(0);
          }
        }
      }),
      { numRuns: 300 }
    );
  });

  it('never emits cleared without a prior failure', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 20 }), (opens) => {
        let win = createWindow();
        for (const open of opens) {
          const out = step(win, 'pass', open);
          win = out.window;
          expect(out.emit.some((e) => e.type === 'cleared')).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('defers cleared until the Incident becomes terminal, then emits exactly once', () => {
    let s = step(undefined, 'fail', true);
    s = step(s.window, 'fail', true);
    const emitted = [];
    for (let i = 0; i < 4; i++) {
      s = step(s.window, 'pass', true);
      emitted.push(...s.emit);
    }
    expect(emitted.some((e) => e.type === 'cleared')).toBe(false);
    s = step(s.window, 'pass', false);
    expect(s.emit.filter((e) => e.type === 'cleared')).toHaveLength(1);
    s = step(s.window, 'pass', false);
    expect(s.emit.some((e) => e.type === 'cleared')).toBe(false);
  });

  it('a single pass after a failure does not clear', () => {
    const a = step(undefined, 'fail', false);
    const b = step(a.window, 'pass', false);
    expect(b.emit.some((e) => e.type === 'cleared')).toBe(false);
    const c = step(b.window, 'pass', false);
    expect(c.emit.filter((e) => e.type === 'cleared')).toHaveLength(1);
  });
});
