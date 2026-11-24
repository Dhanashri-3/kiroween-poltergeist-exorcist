import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import Dashboard from './Dashboard.jsx';
import { build, ev, stateEv, passVerification, INC } from './testHelpers.js';

afterEach(cleanup);

const noop = () => Promise.resolve({});
const show = (state) => render(
  <Dashboard state={state} connection={{ status: 'connected', error: null, lastSeq: 0 }} onStartChaos={noop} onReset={noop} />,
);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const plan = (seq, change, extra = {}, rejected = false) =>
  ev(seq, 'plan', { plan: { incidentId: INC, actionType: 'text_replace', targetFile: 'src/Cart.jsx', change, rationale: 'r', ...extra }, rejected });
const repair = (seq, over = {}) =>
  ev(seq, 'repair', { incidentId: INC, target: 'src/Cart.jsx', snapshotId: 'snap1', preChecksum: A, postChecksum: B, snapshotChecksums: [{ path: 'src/Cart.jsx', checksum: A }], ...over });

describe('repair record and plan-derived preview', () => {
  it('shows the record and a clearly labelled preview with +/- lines', () => {
    show(build([plan(1, { find: 'old1\nold2', replace: 'new1' }), repair(2), stateEv(3, 'verifying')]));
    const record = screen.getByTestId('repair-record');
    expect(record.textContent).toContain('src/Cart.jsx');
    expect(screen.getByTestId('repair-snapshot').textContent).toBe('snap1');
    expect(screen.getByTestId('repair-pre').textContent).toBe(A);
    expect(screen.getByTestId('repair-post').textContent).toBe(B);
    expect(screen.getByTestId('repair-compare').textContent).toBe('different');
    expect(screen.getByTestId('repair-snapshot-checksums').textContent).toContain('src/Cart.jsx');
    const preview = screen.getByTestId('plan-preview');
    expect(preview.textContent).toContain('Plan-derived preview (NOT the actual file change)');
    expect(preview.textContent).toContain('not a before/after diff of the file');
    expect(screen.getAllByTestId('preview-removed-line').map((n) => n.textContent)).toEqual([
      'Removed line: - old1\n', 'Removed line: - old2\n']);
    expect(screen.getAllByTestId('preview-added-line').map((n) => n.textContent)).toEqual(['Added line: + new1\n']);
    expect(screen.getByTestId('repair-record').textContent).not.toContain('old1');
  });

  it('never uses "applied diff" or "actual changes" wording', () => {
    const { container } = show(build([plan(1, { find: 'a', replace: 'b' }), repair(2)]));
    expect(container.textContent).not.toMatch(/applied (repair )?diff|actual changes/i);
    expect(container.querySelector('[aria-label*="pplied"]')).toBeNull();
  });

  it('shows equal checksums as equal', () => {
    show(build([plan(1, { find: 'a', replace: 'b' }), repair(2, { postChecksum: A })]));
    expect(screen.getByTestId('repair-compare').textContent).toBe('equal');
  });

  it('shows not available for missing checksums and fields', () => {
    show(build([plan(1, { find: 'a', replace: 'b' }), ev(2, 'repair', { incidentId: INC, target: 'src/Cart.jsx' })]));
    expect(screen.getByTestId('repair-pre').textContent).toBe('not available');
    expect(screen.getByTestId('repair-post').textContent).toBe('not available');
    expect(screen.getByTestId('repair-compare').textContent).toBe('not available');
    expect(screen.getByTestId('repair-snapshot').textContent).toBe('not available');
    expect(screen.queryByTestId('repair-snapshot-checksums')).toBeNull();
  });

  it('shows an omitted repair payload and no preview', () => {
    show(build([plan(1, { find: 'a', replace: 'b' }), ev(2, 'repair', { ref: 'r.payload.json', bytes: 70000 })]));
    expect(screen.getByTestId('repair-omitted').textContent).toContain('70000');
    expect(screen.queryByTestId('plan-preview')).toBeNull();
  });

  it('says No repair applied and shows no preview when there is only a plan', () => {
    show(build([plan(1, { find: 'a', replace: 'b' }), stateEv(2, 'planning')]));
    expect(screen.getByTestId('repair-none').textContent).toBe('No repair applied.');
    expect(screen.queryByTestId('plan-preview')).toBeNull();
    expect(screen.queryByTestId('plan-preview-lines')).toBeNull();
  });

  it('ignores a rejected plan', () => {
    show(build([plan(1, { find: 'good', replace: 'fine' }), plan(2, { find: 'bad', replace: 'worse' }, {}, true), repair(3)]));
    const text = screen.getByTestId('plan-preview-lines').textContent;
    expect(text).toContain('good');
    expect(text).not.toContain('bad');
  });

  it('shows preview unavailable for non-string find/replace', () => {
    show(build([plan(1, { find: 1, replace: ['x'] }), repair(2)]));
    expect(screen.getByTestId('plan-preview-unavailable').textContent).toBe('Plan-derived preview not available.');
    expect(screen.getByTestId('repair-pre').textContent).toBe(A);
  });

  it('flags a plan target that differs from the repair target and still labels it a preview', () => {
    show(build([plan(1, { find: 'a', replace: 'b' }, { targetFile: 'src/Other.jsx' }), repair(2)]));
    expect(screen.getByTestId('plan-preview-mismatch').textContent).toContain('Plan target differs from repair target');
    expect(screen.getByTestId('plan-preview').textContent).toContain('Plan-derived preview');
  });
});

describe('recovery panel link', () => {
  it('links the recovered banner to its supporting Verification_Result', () => {
    show(build([plan(1, { find: 'a', replace: 'b' }), repair(2), ev(3, 'verification', passVerification), stateEv(4, 'recovered')]));
    const link = screen.getByTestId('recovery-verification-link');
    expect(link.getAttribute('href')).toBe('#recovery-verification-panel');
    expect(link.textContent).toContain('v-1');
    const target = document.getElementById('recovery-verification-panel');
    expect(target).toBe(screen.getByTestId('recovery-verification'));
    expect(target.getAttribute('data-overall')).toBe('pass');
  });

  it('renders no recovered banner or link when recovered has no passing verification', () => {
    show(build([repair(1), stateEv(2, 'recovered')]));
    expect(screen.getByTestId('outcome').getAttribute('data-outcome')).toBe('unverified_recovery_claim');
    expect(screen.queryByTestId('recovery-verification-link')).toBeNull();
    expect(screen.queryByText(/Recovered \(verified\)/)).toBeNull();
  });
});
