import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import AgentLogPill, { EXPANDED_LINES } from './AgentLogPill.jsx';
import { buildLogLines } from '../state/agentLog.js';
import { ev } from '../../components/testHelpers.js';

afterEach(cleanup);

const events = Array.from({ length: 12 }, (_, i) => ev(i + 1, i % 3 === 0 ? 'chaos.injection' : i % 3 === 1 ? 'diagnosis' : 'gate', { decision: 'approved', status: 'accepted' }));

describe('AgentLogPill', () => {
  it('is an accessible log named "Agent activity"', () => {
    render(<AgentLogPill />);
    const log = screen.getByRole('log', { name: 'Agent activity' });
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.textContent).toBe('No agent activity yet.');
  });

  it('shows only the newest line when collapsed and the newest lines when expanded', () => {
    render(<AgentLogPill lines={buildLogLines({ events })} />);
    expect(screen.getAllByTestId('so-log-line').map((l) => l.getAttribute('data-seq'))).toEqual(['12']);
    const toggle = screen.getByRole('button', { name: 'Show agent activity history' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(screen.getByRole('log').id);
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide agent activity history' }).getAttribute('aria-expanded')).toBe('true');
    const seqs = screen.getAllByTestId('so-log-line').map((l) => Number(l.getAttribute('data-seq')));
    expect(seqs).toHaveLength(EXPANDED_LINES);
    expect(seqs).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('labels lines with [POLTERGEIST], [EXORCIST] and [SYSTEM] tags in Event order', () => {
    render(<AgentLogPill defaultOpen lines={buildLogLines({ events: events.slice(0, 3) })} />);
    expect(screen.getAllByTestId('so-log-line').map((l) => l.querySelector('.so-log__tag').textContent))
      .toEqual(['[POLTERGEIST]', '[EXORCIST]', '[SYSTEM]']);
  });

  it('animates only live lines', () => {
    render(<AgentLogPill defaultOpen lines={buildLogLines({ events: events.slice(0, 3), watermark: 2 })} />);
    expect(screen.getAllByTestId('so-log-line').map((l) => l.className.includes('so-log__line--live'))).toEqual([false, false, true]);
  });

  it('marks the compact indicator with the newest actor and flags client-side notes', () => {
    const lines = buildLogLines({ events: events.slice(0, 2), notes: [{ id: 'x', text: 'Client-side: refresh failed', afterSeq: 2 }] });
    const { rerender } = render(<AgentLogPill lines={buildLogLines({ events: events.slice(0, 1) })} />);
    expect(screen.getByTestId('so-log-pip').getAttribute('data-actor')).toBe('POLTERGEIST');
    rerender(<AgentLogPill lines={lines} />);
    expect(screen.getByTestId('so-log-pip').getAttribute('data-source')).toBe('client');
    expect(screen.getByTestId('so-log-pip').getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the log announced and the toggle named "agent activity" in compact mode', () => {
    render(<AgentLogPill lines={buildLogLines({ events })} />);
    // The list stays in the DOM (visually hidden below 480 px by CSS), so new lines are still announced.
    expect(screen.getByRole('log', { name: 'Agent activity' }).textContent).toContain('[SYSTEM]');
    const toggle = screen.getByRole('button', { name: /agent activity/i });
    expect(toggle.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThanOrEqual(2);
    expect(toggle.tagName).toBe('BUTTON'); // native button: Enter and Space activate it (checked in the browser run)
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('log').tabIndex).toBe(0); // expanded history is keyboard scrollable
  });

  it('does not reuse Dashboard event-row test ids', () => {
    render(<AgentLogPill defaultOpen lines={buildLogLines({ events })} />);
    expect(document.querySelectorAll('[data-testid="event-row"]')).toHaveLength(0);
  });
});
