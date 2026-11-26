/** First focusable element. Hidden until focused; jumps to the Dashboard wrapper (#so-dashboard). */
export default function SkipLink({ targetId = 'so-dashboard', children = 'Skip to dashboard' }) {
  return <a className="so-skip" href={`#${targetId}`}>{children}</a>;
}
