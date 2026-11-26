import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
import DefenseMesh, { HEAL_MS, STRIKE_TIMING } from './DefenseMesh.jsx';

const health = (components) => ({ status: 'degraded', testApp: { reachable: true, httpStatus: 200, components }, storage: { ok: true } });
const cardFor = (key) => screen.getAllByTestId('so-card').find((el) => el.getAttribute('data-key') === key);

function stubReducedMotion(matches) {
  vi.stubGlobal('matchMedia', (query) => ({
    matches: matches && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DefenseMesh', () => {
  it('renders a labelled section with four headed cards in the approved order', () => {
    render(<DefenseMesh />);
    const section = screen.getByRole('region', { name: 'Defense Mesh' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Defense Mesh' })).toBeTruthy();
    expect(within(section).getAllByRole('heading', { level: 3 }).map((h) => h.textContent))
      .toEqual(['Neural Core', 'Edge Firewall', 'Vault Auth', 'System Layout']);
    expect(screen.getAllByTestId('so-card').map((el) => el.getAttribute('data-key'))).toEqual(['dataPanel', 'button', 'card', 'layout']);
  });

  it('shows an honest unavailable state without health data', () => {
    render(<DefenseMesh health={null} />);
    for (const el of screen.getAllByTestId('so-card')) {
      expect(within(el).getByTestId('so-card-badge').textContent).toBe('UNAVAILABLE');
      expect(within(el).getByTestId('so-card-health').textContent).toBe('No health data yet.');
      expect(within(el).getByTestId('so-card-incident').textContent).toBe('None');
    }
    expect(screen.queryByTestId('so-crack')).toBeNull();
  });

  it('shows nominal and breached checks with the backend error text', () => {
    render(<DefenseMesh health={health({ dataPanel: { status: 'ok' }, button: { status: 'fail', error: 'onClick missing' } })} />);
    expect(within(cardFor('dataPanel')).getByTestId('so-card-badge').textContent).toBe('NOMINAL');
    const button = cardFor('button');
    expect(within(button).getByTestId('so-card-badge').textContent).toBe('BREACHED // FAULT');
    expect(within(button).getByTestId('so-card-error').textContent).toBe('onClick missing');
    // History renders in steady state: cracks are present but not drawn by an animation.
    const crack = within(button).getByTestId('so-crack');
    expect(crack.getAttribute('class')).not.toContain('so-crack--draw');
    expect(button.className).not.toMatch(/so-card--struck/);
  });

  it('draws cracks only when damage appears after live changes are enabled', () => {
    const { rerender } = render(<DefenseMesh health={health({ button: { status: 'ok' } })} animateChanges />);
    rerender(<DefenseMesh health={health({ button: { status: 'fail' } })} animateChanges />);
    const button = cardFor('button');
    expect(within(button).getByTestId('so-crack').getAttribute('class')).toContain('so-crack--draw');
    expect(button.className).toMatch(/so-card--struck-a/);
  });

  it('lists app-level Incidents separately from the cards', () => {
    render(<DefenseMesh incidents={[
      { incidentId: 'inc-app', component: 'app', outcome: 'active' },
      { incidentId: 'inc-btn', component: 'button', outcome: 'active' },
    ]} />);
    const items = screen.getAllByTestId('so-applevel-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('inc-app');
    expect(items[0].textContent).toContain('Whole Test_App');
    expect(within(cardFor('button')).getByTestId('so-card-incident').textContent).toContain('inc-btn');
    for (const key of ['dataPanel', 'card', 'layout']) {
      expect(within(cardFor(key)).getByTestId('so-card-incident').textContent).toBe('None');
    }
  });

  it('renders no app-level block when there are none', () => {
    render(<DefenseMesh />);
    expect(screen.queryByTestId('so-applevel')).toBeNull();
  });

  it('shows the reaper only while a strike is supplied, and runs the strike phases', () => {
    vi.useFakeTimers();
    const { rerender } = render(<DefenseMesh />);
    expect(screen.queryByTestId('so-reaper')).toBeNull();
    rerender(<DefenseMesh strike={{ targetKey: 'button', token: 7 }} />);
    expect(screen.getByTestId('so-reaper').getAttribute('data-phase')).toBe('arrive');
    act(() => { vi.advanceTimersByTime(STRIKE_TIMING.fire); });
    expect(screen.getByTestId('so-beam')).toBeTruthy();
    expect(within(cardFor('button')).getByTestId('so-slash')).toBeTruthy();
    expect(within(cardFor('card')).queryByTestId('so-slash')).toBeNull();
    act(() => { vi.advanceTimersByTime(STRIKE_TIMING.hold - STRIKE_TIMING.fire); });
    expect(screen.getByTestId('so-reaper').getAttribute('data-phase')).toBe('hold');
    expect(screen.queryByTestId('so-beam')).toBeNull();
    rerender(<DefenseMesh strike={null} />);
    expect(screen.queryByTestId('so-reaper')).toBeNull();
  });

  it('places the reaper in its dedicated lane, outside every card', () => {
    render(<DefenseMesh health={health({ button: { status: 'fail' } })} strike={{ targetKey: 'button', token: 2 }} />);
    const lane = screen.getByTestId('so-reaper-lane');
    expect(lane.getAttribute('aria-hidden')).toBe('true');
    expect(lane.contains(screen.getByTestId('so-reaper'))).toBe(true);
    for (const card of screen.getAllByTestId('so-card')) expect(lane.contains(card) || card.contains(lane)).toBe(false);
    // The lane is a sibling of the heading block and the grid, not inside them.
    expect(lane.parentElement.className).toBe('so-mesh__inner');
  });

  it('keeps the lane empty without a strike, and never targets an unknown key', () => {
    const { rerender } = render(<DefenseMesh />);
    expect(screen.getByTestId('so-reaper-lane').children).toHaveLength(0);
    rerender(<DefenseMesh strike={{ targetKey: 'not-a-card', token: 3 }} />);
    // A caller-supplied key that matches no card shows the reaper in its lane but slashes nothing.
    expect(screen.queryByTestId('so-slash')).toBeNull();
    expect(screen.queryByTestId('so-beam')).toBeNull();
  });

  it('renders the crack overlay as a decorative layer after the card content, not inside it', () => {
    render(<DefenseMesh health={health({ button: { status: 'fail', error: 'boom' } })} />);
    const card = cardFor('button');
    const crack = within(card).getByTestId('so-crack');
    const body = card.querySelector('.so-card__body');
    expect(body.contains(crack)).toBe(false);
    expect(crack.getAttribute('aria-hidden')).toBe('true');
    expect(within(cardFor('dataPanel')).queryByTestId('so-crack')).toBeNull(); // nominal: no cracks
  });

  it('keeps the reaper out of the accessibility tree', () => {
    render(<DefenseMesh strike={{ targetKey: 'layout', token: 1 }} />);
    expect(screen.getByTestId('so-reaper').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('so-reaper').querySelector('img').getAttribute('alt')).toBe('');
  });

  it('plays a heal pulse only on a verified card, then removes it', () => {
    vi.useFakeTimers();
    const recovered = [{ incidentId: 'i1', component: 'button', outcome: 'recovered' }];
    const { rerender } = render(<DefenseMesh health={health({ button: { status: 'ok' } })} incidents={recovered} heal={{ targetKey: 'button', token: 9 }} />);
    expect(within(cardFor('button')).getByTestId('so-heal')).toBeTruthy();
    expect(within(cardFor('button')).getByTestId('so-card-badge').textContent).toBe('PATCHED // VERIFIED');
    act(() => { vi.advanceTimersByTime(HEAL_MS); });
    expect(screen.queryByTestId('so-heal')).toBeNull();

    const rolledBack = [{ incidentId: 'i1', component: 'button', outcome: 'rolled_back' }];
    rerender(<DefenseMesh health={health({ button: { status: 'ok' } })} incidents={rolledBack} heal={{ targetKey: 'button', token: 10 }} />);
    expect(screen.queryByTestId('so-heal')).toBeNull();
    expect(within(cardFor('button')).getByTestId('so-card-badge').textContent).not.toContain('VERIFIED');
  });

  describe('reduced motion', () => {
    it('places the reaper at rest with no beam, slash or heal pulse', () => {
      stubReducedMotion(true);
      vi.useFakeTimers();
      const recovered = [{ incidentId: 'i1', component: 'card', outcome: 'recovered' }];
      render(<DefenseMesh incidents={recovered} strike={{ targetKey: 'button', token: 3 }} heal={{ targetKey: 'card', token: 4 }} />);
      expect(screen.getByTestId('so-reaper').getAttribute('data-phase')).toBe('hold');
      act(() => { vi.advanceTimersByTime(STRIKE_TIMING.hold); });
      expect(screen.queryByTestId('so-beam')).toBeNull();
      expect(screen.queryByTestId('so-slash')).toBeNull();
      expect(screen.queryByTestId('so-heal')).toBeNull();
      // The verified state is still shown; only the motion is removed.
      expect(within(cardFor('card')).getByTestId('so-card-badge').textContent).toBe('PATCHED // VERIFIED');
    });
  });
});
