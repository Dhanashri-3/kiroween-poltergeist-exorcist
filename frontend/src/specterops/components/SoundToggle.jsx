import { Icon } from './icons.jsx';

export const SOUND_NOTE_ID = 'so-sound-note';

/**
 * Sound switch (Phase 4B.4B). Same conventions as ThemeToggle: a `.so-iconbtn` toggle button with a stable
 * accessible name ("Sound") and aria-pressed, so the state is announced instead of the name changing.
 *
 * It holds no audio state. The caller decides what a click does (unlock or mute) and passes the result back.
 * The button stays focusable when audio is unsupported, so the reason can be read; a click then reports it
 * through `note`, shown in one polite region linked with aria-describedby.
 *
 * Props: on, busy, available, note (string|null), onToggle().
 */
export default function SoundToggle({ on = false, busy = false, available = true, note = null, onToggle }) {
  const title = !available
    ? 'Sound is not supported in this browser'
    : on ? 'Sound is on' : 'Sound is off';
  return (
    <span className="so-sound">
      <button type="button" className="so-iconbtn so-sound-toggle" aria-label="Sound" aria-pressed={on}
        aria-busy={busy || undefined} aria-describedby={note ? SOUND_NOTE_ID : undefined} title={title}
        data-available={available ? 'true' : 'false'}
        onClick={() => { if (!busy) onToggle?.(); }}>
        <Icon name={on ? 'speaker' : 'speakerOff'} />
      </button>
      <span id={SOUND_NOTE_ID} className="so-sound__note" aria-live="polite">
        {note ? <span className="so-sound__msg">{note}</span> : null}
      </span>
    </span>
  );
}
