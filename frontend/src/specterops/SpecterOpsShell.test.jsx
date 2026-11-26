import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, renderHook, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import SpecterOpsShell from './SpecterOpsShell.jsx';
import { useHistoryWatermark } from './hooks/useHistoryWatermark.js';
import { useVisibility } from './hooks/useVisibility.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Stand-in for the Dashboard: a <main> with the page's <h1>, as the real Dashboard renders.
const FakeDashboard = () => (
  <main data-testid="stand-in-dashboard"><h1>Poltergeist vs. Exorcist</h1></main>
);

describe('SpecterOpsShell structure', () => {
  it('adds no main landmark and no h1 of its own', () => {
    render(<SpecterOpsShell />);
    expect(document.querySelectorAll('main')).toHaveLength(0);
    expect(document.querySelectorAll('h1')).toHaveLength(0);
  });

  it('wraps the Dashboard in #so-dashboard, leaving exactly one main and one h1', () => {
    render(<SpecterOpsShell><FakeDashboard /></SpecterOpsShell>);
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const frame = document.getElementById('so-dashboard');
    expect(frame.contains(screen.getByTestId('stand-in-dashboard'))).toBe(true);
    expect(frame.tabIndex).toBe(-1);
  });

  it('uses h2 for the hero and Defense Mesh headings', () => {
    render(<SpecterOpsShell />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent))
      .toEqual(['Autonomous Chaos Defense', 'Defense Mesh']);
    expect(document.body.textContent).not.toMatch(/zero downtime|local sim|banish/i);
  });

  it('starts with the skip link and orders landmarks hero, mesh, dashboard, log', () => {
    render(<SpecterOpsShell />);
    const root = screen.getByTestId('specterops-shell');
    expect(root.firstElementChild.getAttribute('href')).toBe('#so-dashboard');
    expect([...root.children].map((el) => el.id || el.className)).toEqual(['so-skip', 'so-overview', 'so-defense-mesh', 'so-dashboard', 'so-logdock']);
    expect(screen.getByRole('banner', { name: 'Autonomous Chaos Defense' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'SpecterOps' })).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Agent activity' })).toBeTruthy();
  });

  it('hides every decorative image from assistive technology', () => {
    render(<SpecterOpsShell strike={{ targetKey: 'button', token: 1 }} />);
    const images = [...document.querySelectorAll('.specterops-shell img')];
    expect(images.length).toBeGreaterThanOrEqual(6);
    for (const img of images) {
      expect(img.getAttribute('alt')).toBe('');
      expect(img.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(img.getAttribute('decoding')).toBe('async');
    }
    // Large below-the-fold art is lazy-loaded.
    for (const cls of ['so-skullhand__hand-img', 'so-skullhand__skull-lit', 'so-mesh__crypt', 'so-reaper__img']) {
      expect(document.querySelector(`.${cls}`).getAttribute('loading'), cls).toBe('lazy');
    }
  });

  it('renders no reaper without a genuine strike', () => {
    render(<SpecterOpsShell />);
    expect(screen.queryByTestId('so-reaper')).toBeNull();
    expect(document.querySelector('.so-reaper__img')).toBeNull();
  });

  it('adds no control named like the Dashboard Start chaos, Reset or Back buttons', () => {
    render(<SpecterOpsShell summon={{ onSummon: () => {} }} connectionStatus="connected" />);
    for (const el of [...screen.getAllByRole('button'), ...screen.getAllByRole('link')]) {
      const name = (el.getAttribute('aria-label') ?? el.textContent).toLowerCase();
      expect(name).not.toMatch(/reset|start chaos|back to current incident/);
    }
  });
});

describe('SpecterOpsShell theme', () => {
  it('defaults to dark and toggles the light theme on the shell root only', () => {
    render(<SpecterOpsShell><FakeDashboard /></SpecterOpsShell>);
    const root = screen.getByTestId('specterops-shell');
    expect(root.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Light theme' }));
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Light theme' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('stand-in-dashboard').closest('[data-theme]')).toBe(root);
    expect(screen.getByTestId('stand-in-dashboard').hasAttribute('data-theme')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Light theme' }));
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('accepts a light default', () => {
    render(<SpecterOpsShell defaultTheme="light" />);
    expect(screen.getByTestId('specterops-shell').getAttribute('data-theme')).toBe('light');
  });
});

describe('SpecterOpsShell reduced motion', () => {
  it('marks the shell when the user prefers reduced motion', () => {
    vi.stubGlobal('matchMedia', (query) => ({
      matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener() {}, removeEventListener() {},
    }));
    render(<SpecterOpsShell />);
    expect(screen.getByTestId('specterops-shell').getAttribute('data-motion')).toBe('reduced');
  });

  it('uses full motion otherwise, with the hand at rest until the observer reports a scroll', () => {
    render(<SpecterOpsShell />);
    expect(screen.getByTestId('specterops-shell').getAttribute('data-motion')).toBe('full');
    expect(screen.getByTestId('so-skullhand').className).not.toContain('so-skullhand--caught');
  });
});

describe('SpecterOpsShell data flow', () => {
  it('passes Defense Mesh data and log lines straight through', () => {
    const lines = [{ key: 'e-1', actor: 'POLTERGEIST', text: 'Injected scenario s into component button.', seq: 1, live: false }];
    render(<SpecterOpsShell
      health={{ status: 'degraded', testApp: { reachable: true, components: { button: { status: 'fail', error: 'x' } } } }}
      logLines={lines} />);
    const button = screen.getAllByTestId('so-card').find((el) => el.getAttribute('data-key') === 'button');
    expect(within(button).getByTestId('so-card-badge').textContent).toBe('BREACHED // FAULT');
    expect(screen.getByRole('log', { name: 'Agent activity' }).textContent).toBe('[POLTERGEIST] Injected scenario s into component button.');
  });
});

describe('useHistoryWatermark', () => {
  it('fixes the watermark the first time ready is true and never moves it', () => {
    const { result, rerender } = renderHook((props) => useHistoryWatermark(props), { initialProps: { events: [{ seq: 4 }], ready: false } });
    expect(result.current).toBeNull();
    rerender({ events: [{ seq: 4 }, { seq: 6 }], ready: true });
    expect(result.current).toBe(6);
    rerender({ events: [{ seq: 4 }, { seq: 6 }, { seq: 9 }], ready: true });
    expect(result.current).toBe(6);
  });

  it('uses -1 for an empty history so a first Event with seq 0 counts as live', () => {
    const { result } = renderHook(() => useHistoryWatermark({ events: [], ready: true }));
    expect(result.current).toBe(-1);
  });
});

describe('useVisibility', () => {
  it('returns null where IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const ref = { current: document.createElement('div') };
    const { result } = renderHook(() => useVisibility(ref, 0.5));
    expect(result.current).toBeNull();
  });

  it('reports the observed ratio against the threshold and disconnects on unmount', () => {
    let callback;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb) { callback = cb; }
      observe() {}
      disconnect() { disconnect(); }
    });
    const ref = { current: document.createElement('div') };
    const { result, unmount } = renderHook(() => useVisibility(ref, 0.75));
    act(() => callback([{ isIntersecting: true, intersectionRatio: 0.9 }]));
    expect(result.current).toBe(true);
    act(() => callback([{ isIntersecting: true, intersectionRatio: 0.4 }]));
    expect(result.current).toBe(false);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
