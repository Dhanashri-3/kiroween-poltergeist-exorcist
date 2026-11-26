/**
 * Phase 4B.4B: Sound toggle and its place in the floating navigation.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import SoundToggle, { SOUND_NOTE_ID } from './SoundToggle.jsx';
import FloatingNav from './FloatingNav.jsx';

afterEach(cleanup);

const tabOrder = () => [...document.querySelectorAll('a, button')].map((el) => el.getAttribute('aria-label') ?? el.textContent);

describe('SoundToggle', () => {
  it('starts off, with a stable name, aria-pressed and a decorative icon', () => {
    render(<SoundToggle onToggle={() => {}} />);
    const button = screen.getByRole('button', { name: 'Sound' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.className).toContain('so-iconbtn');
    expect(button.getAttribute('title')).toBe('Sound is off');
    const svg = button.querySelector('svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('data-icon')).toBe('speakerOff');
  });

  it('reports the on state through aria-pressed without changing its name', () => {
    render(<SoundToggle on onToggle={() => {}} />);
    const button = screen.getByRole('button', { name: 'Sound' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.querySelector('svg').getAttribute('data-icon')).toBe('speaker');
  });

  it('calls onToggle on click and on keyboard activation, and ignores clicks while busy', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<SoundToggle onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: 'Sound' });
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(button.tagName).toBe('BUTTON'); // native button: Enter and Space activate it
    expect(button.tabIndex).toBe(0);
    rerender(<SoundToggle busy onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'Sound' }).getAttribute('aria-busy')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Sound' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('stays focusable when unsupported and explains why', () => {
    const { rerender } = render(<SoundToggle available={false} onToggle={() => {}} />);
    const button = screen.getByRole('button', { name: 'Sound' });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('title')).toBe('Sound is not supported in this browser');
    rerender(<SoundToggle available={false} note="Sound is not supported in this browser." onToggle={() => {}} />);
    const note = document.getElementById(SOUND_NOTE_ID);
    expect(note.getAttribute('aria-live')).toBe('polite');
    expect(note.getAttribute('role')).toBeNull();
    expect(note.textContent).toBe('Sound is not supported in this browser.');
    expect(screen.getByRole('button', { name: 'Sound' }).getAttribute('aria-describedby')).toBe(SOUND_NOTE_ID);
  });

  it('adds no alert and no status role', () => {
    render(<SoundToggle note="The browser blocked audio. Sound stays off." onToggle={() => {}} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('FloatingNav with and without sound', () => {
  it('without a sound prop keeps the exact existing navigation and focus order', () => {
    render(<FloatingNav summon={{ onSummon: () => {} }} />);
    expect(screen.queryByRole('button', { name: 'Sound' })).toBeNull();
    expect(tabOrder()).toEqual(['SPECTEROPS', 'Overview', 'Defense Mesh', 'Dashboard', 'Light theme', 'Summon Poltergeist']);
  });

  it('with a sound prop places the Sound control right after the theme toggle', () => {
    render(<FloatingNav summon={{ onSummon: () => {} }} sound={{ on: false, onToggle: () => {} }} />);
    expect(tabOrder()).toEqual(['SPECTEROPS', 'Overview', 'Defense Mesh', 'Dashboard', 'Light theme', 'Sound', 'Summon Poltergeist']);
    for (const el of document.querySelectorAll('a, button')) expect(el.tabIndex).toBe(0);
  });
});
