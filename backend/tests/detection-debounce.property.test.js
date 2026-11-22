import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { step, createWindow } from '../src/monitor/debounce.js';

// Feature: poltergeist-exorcist-healing-system, Property 5: Detection debounce
// **Validates: Requirements 5.3, 5.5, 5.8**

const resultArb = fc.constantFrom('pass', 'fail', 'unreachable');

describe('Property 5: Detection debounce', () => {
  it('emits detection/transient exactly per the debounce rules for any result sequence', () => {
    fc.assert(
      fc.property(fc.array(resultArb, { maxLength: 40 }), (results) => {
        let win = createWindow();
        let prev = null; // previous result
        let prevAvail = false; // previous failure streak contained an unreachable
        let streak = 0;
        let streakAvail = false;

        for (const r of results) {
          const out = step(win, r, false);
          win = out.window;
          const detections = out.emit.filter((e) => e.type === 'detection');
          const transients = out.emit.filter((e) => e.type === 'transient');

          if (r === 'unreachable') {
            // 5.8: availability-failure detection whenever unreachable
            expect(detections).toEqual([{ type: 'detection', kind: 'availability' }]);
            expect(transients).toHaveLength(0);
            streak += 1;
            streakAvail = true;
          } else if (r === 'fail') {
            streak += 1;
            // 5.3: detection exactly on the second consecutive failure
            // (unless the streak already reported an availability failure)
            if (streak === 2 && !streakAvail) {
              expect(detections).toEqual([{ type: 'detection', kind: 'failure' }]);
            } else {
              expect(detections).toHaveLength(0);
            }
            expect(transients).toHaveLength(0);
          } else {
            // pass: no detection; 5.5 transient iff exactly one failure preceded it
            expect(detections).toHaveLength(0);
            expect(transients).toHaveLength(streak === 1 && !streakAvail ? 1 : 0);
            streak = 0;
            streakAvail = false;
          }
          prev = r;
          prevAvail = streakAvail;
        }
        void prev; void prevAvail;
      }),
      { numRuns: 200 }
    );
  });

  it('single failure then pass emits transient and no detection', () => {
    const a = step(undefined, 'fail', false);
    const b = step(a.window, 'pass', false);
    expect([...a.emit, ...b.emit].some((e) => e.type === 'detection')).toBe(false);
    expect(b.emit.filter((e) => e.type === 'transient')).toHaveLength(1);
  });

  it('two consecutive failures emit one detection', () => {
    const a = step(undefined, 'fail', false);
    const b = step(a.window, 'fail', false);
    expect(b.emit.filter((e) => e.type === 'detection')).toHaveLength(1);
  });
});
