import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPoltergeist, PoltergeistError } from '../src/poltergeist/poltergeist.js';

const CATALOG = [
  { id: 'a', label: 'A', severity: 'low', targetFiles: ['x.js'], secret: 1 },
  { id: 'b', label: 'B', severity: 'high' },
];

function setup(extra = {}) {
  const events = [];
  const calls = [];
  const scenarioEngine = { inject: vi.fn(async (...a) => { calls.push(a); }) };
  const eventRecorder = { append: vi.fn(async (e) => { events.push(e); return e; }) };
  let n = 0;
  const p = createPoltergeist({ catalogView: CATALOG, scenarioEngine, eventRecorder, idFactory: () => `run-${++n}`, random: () => 0.99, ...extra });
  return { p, events, calls, scenarioEngine };
}

describe('Poltergeist', () => {
  it('selects from the catalog, records a selection Event with run ID and rationale (4.1, 4.4)', async () => {
    const { p, events } = setup();
    const sel = await p.select();
    expect(sel).toMatchObject({ runId: 'run-1', scenarioId: 'b' });
    expect(sel.rationale).toBeTruthy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'chaos.selection', component: 'poltergeist', incidentId: null, runId: 'run-1' });
    expect(events[0].payload).toMatchObject({ scenarioId: 'b', rationale: sel.rationale });
  });

  it('uses a validated user choice verbatim (4.6)', async () => {
    const { p } = setup();
    expect(await p.select({ scenarioId: 'a' })).toMatchObject({ scenarioId: 'a' });
  });

  it('rejects a scenario not in the catalog without recording or injecting (4.1)', async () => {
    const { p, events, scenarioEngine } = setup();
    await expect(p.startRun({ scenarioId: 'zzz' })).rejects.toMatchObject({ code: 'unknown_scenario' });
    expect(events).toHaveLength(0);
    expect(scenarioEngine.inject).not.toHaveBeenCalled();
  });

  it('passes only public fields to a chooser and validates its answer', async () => {
    const chooser = vi.fn(async () => ({ scenarioId: 'a', rationale: 'because' }));
    const { p } = setup({ chooser });
    const sel = await p.select();
    expect(chooser.mock.calls[0][0]).toEqual([
      { id: 'a', label: 'A', severity: 'low' },
      { id: 'b', label: 'B', severity: 'high' },
    ]);
    expect(sel).toMatchObject({ scenarioId: 'a', rationale: 'because' });
    const bad = setup({ chooser: async () => ({ scenarioId: 'nope' }) });
    await expect(bad.p.select()).rejects.toBeInstanceOf(PoltergeistError);
  });

  it('triggers failures only via inject(scenarioId, runId), after recording selection (4.2)', async () => {
    const { p, calls, events } = setup();
    const sel = await p.startRun({ scenarioId: 'a' });
    expect(calls).toEqual([['a', sel.runId]]);
    expect(events[0].type).toBe('chaos.selection');
  });

  it('records battle_result referencing run ID and Incident ID at terminal state (4.7)', async () => {
    const { p, events } = setup();
    await p.recordBattleResult({ runId: 'run-9', incidentId: 'inc-1', state: 'recovered' });
    expect(events[0]).toMatchObject({ type: 'battle_result', runId: 'run-9', incidentId: 'inc-1' });
    expect(events[0].payload).toMatchObject({ runId: 'run-9', incidentId: 'inc-1', state: 'recovered' });
    await expect(p.recordBattleResult({ runId: 'r', incidentId: 'i', state: 'repairing' })).rejects.toMatchObject({ code: 'not_terminal' });
  });

  it('source has no fs, child_process or exorcist/storage imports (4.3, 4.5)', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/poltergeist/poltergeist.js'), 'utf8');
    expect(src).not.toMatch(/from\s+['"](node:)?(fs|child_process|net|http|https)/);
    expect(src).not.toMatch(/exorcist\/|storage\/|scenario-engine\//);
  });
});
