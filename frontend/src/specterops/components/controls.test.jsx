import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ThemeToggle from './ThemeToggle.jsx';
import SummonControl from './SummonControl.jsx';
import SkipLink from './SkipLink.jsx';
import FloatingNav from './FloatingNav.jsx';

afterEach(cleanup);

describe('ThemeToggle', () => {
  it('has a stable name and reports state through aria-pressed', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ThemeToggle theme="dark" onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: 'Light theme' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<ThemeToggle theme="light" onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'Light theme' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps its icon out of the accessibility tree', () => {
    const { container } = render(<ThemeToggle />);
    expect(container.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('SummonControl', () => {
  it('calls onSummon with no arguments and claims nothing by itself', () => {
    const onSummon = vi.fn();
    render(<SummonControl onSummon={onSummon} />);
    fireEvent.click(screen.getByRole('button', { name: 'Summon Poltergeist' }));
    expect(onSummon).toHaveBeenCalledTimes(1);
    expect(onSummon.mock.calls[0]).toEqual([]);
    expect(document.querySelector('.so-summon__feedback').textContent).toBe('');
  });

  it('shows a busy, disabled presentation and ignores clicks while busy', () => {
    const onSummon = vi.fn();
    render(<SummonControl onSummon={onSummon} busy />);
    const button = screen.getByRole('button', { name: 'Summoning…' });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(onSummon).not.toHaveBeenCalled();
  });

  it('is disabled when no callback is wired or when disabled is set', () => {
    const { rerender } = render(<SummonControl />);
    expect(screen.getByRole('button', { name: 'Summon Poltergeist' }).disabled).toBe(true);
    rerender(<SummonControl onSummon={() => {}} disabled />);
    expect(screen.getByRole('button', { name: 'Summon Poltergeist' }).disabled).toBe(true);
  });

  it('shows the caller-supplied notice, and an error as an alert in its place', () => {
    const { rerender } = render(<SummonControl onSummon={() => {}} notice="Chaos run request accepted. Waiting for Events." />);
    expect(screen.getByText('Chaos run request accepted. Waiting for Events.')).toBeTruthy();
    rerender(<SummonControl onSummon={() => {}} notice="ignored" error="Another request is already in progress." />);
    expect(screen.getByRole('alert').textContent).toBe('Another request is already in progress.');
    expect(screen.queryByText('ignored')).toBeNull();
  });
});

describe('SkipLink', () => {
  it('targets the Dashboard wrapper', () => {
    render(<SkipLink />);
    expect(screen.getByRole('link', { name: 'Skip to dashboard' }).getAttribute('href')).toBe('#so-dashboard');
  });
});

describe('FloatingNav', () => {
  it('is a labelled nav with section links, theme toggle and summon control', () => {
    render(<FloatingNav theme="dark" onToggleTheme={() => {}} summon={{ onSummon: () => {} }} />);
    const nav = screen.getByRole('navigation', { name: 'SpecterOps' });
    const hrefs = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#so-overview', '#so-overview', '#so-defense-mesh', '#so-dashboard']);
    expect(screen.getByRole('button', { name: 'Light theme' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Summon Poltergeist' })).toBeTruthy();
  });

  it('shows the genuine stream status only when one is passed', () => {
    const { rerender } = render(<FloatingNav />);
    expect(screen.queryByTestId('so-stream-chip')).toBeNull();
    rerender(<FloatingNav connectionStatus="connected" />);
    expect(screen.getByTestId('so-stream-chip').textContent).toBe('Stream Connected');
    rerender(<FloatingNav connectionStatus="made-up" />);
    expect(screen.queryByTestId('so-stream-chip')).toBeNull();
  });

  it('never names a control like the Dashboard Start chaos or Reset buttons', () => {
    render(<FloatingNav connectionStatus="connected" summon={{ onSummon: () => {} }} />);
    for (const el of screen.getAllByRole('button').concat(screen.getAllByRole('link'))) {
      const name = (el.getAttribute('aria-label') ?? el.textContent).toLowerCase();
      expect(name).not.toMatch(/reset|start chaos|back to current incident/);
    }
  });

  it('is reachable in a logical keyboard order', () => {
    render(<FloatingNav summon={{ onSummon: () => {} }} />);
    const order = [...document.querySelectorAll('a, button')].map((el) => el.getAttribute('aria-label') ?? el.textContent);
    expect(order).toEqual(['SPECTEROPS', 'Overview', 'Defense Mesh', 'Dashboard', 'Light theme', 'Summon Poltergeist']);
    for (const el of document.querySelectorAll('a, button')) expect(el.tabIndex).toBe(0);
  });
});
