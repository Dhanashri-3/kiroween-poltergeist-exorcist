import { useEffect, useState } from 'react';

/**
 * Whether `ref.current` is at least `threshold` visible (IntersectionObserver).
 * Returns null until the first observation, and stays null where IntersectionObserver is missing (jsdom,
 * old browsers), so callers fall back to their resting state. The observer is disconnected on unmount.
 */
export function useVisibility(ref, threshold = 0) {
  const [visible, setVisible] = useState(null);

  useEffect(() => {
    const element = ref?.current;
    if (!element || typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') return undefined;
    let observer;
    try {
      observer = new window.IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setVisible(entry.isIntersecting && entry.intersectionRatio >= threshold);
      }, { threshold: [threshold] });
      observer.observe(element);
    } catch {
      return undefined;
    }
    return () => observer.disconnect();
  }, [ref, threshold]);

  return visible;
}

export default useVisibility;
