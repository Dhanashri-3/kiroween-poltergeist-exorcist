import { describe, it, expect } from 'vitest';
import { omittedPayloadBytes, selectRepairView, selectIncidentEvents, selectIncidentEvidenceRefs } from './dashboardViews.js';
import { build, ev, INC } from '../components/testHelpers.js';

describe('omittedPayloadBytes', () => {
  it('recognises only the {ref, bytes} form', () => {
    expect(omittedPayloadBytes({ ref: 'a.payload.json', bytes: 10 })).toBe(10);
    expect(omittedPayloadBytes({ ref: 'a', bytes: 10, extra: 1 })).toBeNull();
    expect(omittedPayloadBytes({ ref: 'a', bytes: '10' })).toBeNull();
    expect(omittedPayloadBytes({})).toBeNull();
    expect(omittedPayloadBytes(null)).toBeNull();
  });
});

describe('selectRepairView', () => {
  const repair = (seq) => ev(seq, 'repair', { incidentId: INC, target: 't', snapshotId: 's', preChecksum: 'p', postChecksum: 'q', snapshotChecksums: {} });
  const plan = (seq, rejected, change) => ev(seq, 'plan', { plan: { change }, rejected });

  it('returns null without a repair Event', () => {
    expect(selectRepairView(build([plan(1, false, { find: 'a', replace: 'b' })]), INC)).toBeNull();
  });

  it('uses the latest accepted plan before the repair for the diff', () => {
    const s = build([plan(1, false, { find: 'a', replace: 'b' }), plan(2, true, { find: 'x', replace: 'y' }), repair(3)]);
    expect(selectRepairView(s, INC)).toMatchObject({ preChecksum: 'p', postChecksum: 'q', checksumsDiffer: true, preview: { find: 'a', replace: 'b', planSeq: 1 } });
  });

  it('gives no preview when the change has no find/replace strings or non-string values', () => {
    expect(selectRepairView(build([plan(1, false, { lines: [1] }), repair(2)]), INC).preview).toBeNull();
    expect(selectRepairView(build([plan(1, false, { find: 1, replace: 'x' }), repair(2)]), INC).preview).toBeNull();
  });

  it('does not fall back to an older plan when the latest accepted plan has no usable change', () => {
    const s = build([plan(1, false, { find: 'a', replace: 'b' }), plan(2, false, {}), repair(3)]);
    expect(selectRepairView(s, INC).preview).toBeNull();
  });

  it('ignores plans after the repair and gives no preview without any accepted plan', () => {
    expect(selectRepairView(build([repair(1), plan(2, false, { find: 'a', replace: 'b' })]), INC).preview).toBeNull();
    expect(selectRepairView(build([plan(1, true, { find: 'a', replace: 'b' }), repair(2)]), INC).preview).toBeNull();
  });

  it('computes checksumsDiffer only from the two strings', () => {
    const r = (pre, post) => build([ev(1, 'repair', { target: 't', preChecksum: pre, postChecksum: post })]);
    expect(selectRepairView(r('a', 'a'), INC).checksumsDiffer).toBe(false);
    expect(selectRepairView(r('a', 'b'), INC).checksumsDiffer).toBe(true);
    expect(selectRepairView(r('a', undefined), INC)).toMatchObject({ postChecksum: null, checksumsDiffer: null });
    expect(selectRepairView(r(5, 'b'), INC)).toMatchObject({ preChecksum: null, checksumsDiffer: null });
  });

  it('flags a plan target that differs from the repair target', () => {
    const p = (target) => ev(1, 'plan', { plan: { targetFile: target, change: { find: 'a', replace: 'b' } }, rejected: false });
    expect(selectRepairView(build([p('other'), repair(2)]), INC).preview.targetMismatch).toBe(true);
    expect(selectRepairView(build([p('t'), repair(2)]), INC).preview.targetMismatch).toBe(false);
  });

  it('keeps only well-formed snapshotChecksums entries and tolerates the legacy object form', () => {
    const s = build([ev(1, 'repair', { target: 't', snapshotChecksums: [{ path: 'a', checksum: 'c' }, { path: 1 }, null] })]);
    expect(selectRepairView(s, INC).snapshotChecksums).toEqual([{ path: 'a', checksum: 'c' }]);
    expect(selectRepairView(build([repair(1)]), INC).snapshotChecksums).toEqual([]);
  });

  it('flags an omitted repair payload', () => {
    const s = build([ev(1, 'repair', { ref: 'r.json', bytes: 99999 })]);
    expect(selectRepairView(s, INC)).toEqual({ omitted: true, bytes: 99999 });
  });
});

describe('incident event and evidence selectors', () => {
  it('filters by incident and reads evidenceRefs from the API incident only', () => {
    const s = build([ev(1, 'detection', {}, { incidentId: 'a' }), ev(2, 'detection', {}, { incidentId: 'b' })],
      [['incidents', { incidents: [{ incidentId: 'a', state: 'detected', evidenceRefs: ['e1'] }] }]]);
    expect(selectIncidentEvents(s, 'a').map((e) => e.seq)).toEqual([1]);
    expect(selectIncidentEvidenceRefs(s, 'a')).toEqual(['e1']);
    expect(selectIncidentEvidenceRefs(s, 'b')).toEqual([]);
  });
});
