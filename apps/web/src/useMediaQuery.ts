import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query.
 *
 * Used where a layout difference cannot be expressed in CSS alone — showing one
 * of two columns at a time on a phone needs to know *which* one, and that is
 * state, not styling.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (typeof window === 'undefined') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches),
    () => false,
  );
}

/** Phone-width. Matches Tailwind's `sm` breakpoint, so CSS and state agree. */
export const NARROW = '(max-width: 639px)';
