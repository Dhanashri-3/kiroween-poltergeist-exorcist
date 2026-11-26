import { Icon } from './icons.jsx';

/**
 * Light theme switch. A toggle button with a stable accessible name ("Light theme") and aria-pressed,
 * so the state is announced instead of the name changing. Props: theme ('dark' | 'light'), onToggle().
 */
export default function ThemeToggle({ theme = 'dark', onToggle }) {
  const light = theme === 'light';
  return (
    <button type="button" className="so-iconbtn so-theme-toggle" aria-pressed={light}
      aria-label="Light theme" title={light ? 'Light theme is on' : 'Light theme is off'}
      onClick={() => onToggle?.()}>
      <Icon name={light ? 'moon' : 'sun'} />
    </button>
  );
}
