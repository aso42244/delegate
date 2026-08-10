import { useCallback, useSyncExternalStore } from 'react';

/**
 * Row density: 40px comfortable, 32px compact.
 *
 * Stored per device rather than on the server, for the same reason the sidebar's
 * collapsed state is: this is a fact about the screen someone is looking at, not
 * about the household's budget. One person preferring tight rows on a large
 * monitor should not make the other person's phone match.
 *
 * `useSyncExternalStore` rather than `useState` so every component reading the
 * value re-renders together when it changes — including ones in a different part
 * of the tree from the control that changed it.
 */

export type Density = 'comfortable' | 'compact';

const STORAGE_KEY = 'budget.display.density';

const listeners = new Set<() => void>();

function read(): Density {
  if (typeof window === 'undefined') return 'comfortable';
  return window.localStorage.getItem(STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
}

/**
 * The stylesheet keys off `data-density` on the root element, so the whole
 * interface changes at once without a single component knowing the number.
 */
function apply(density: Density): void {
  if (typeof document === 'undefined') return;
  if (density === 'compact') document.documentElement.dataset['density'] = 'compact';
  else delete document.documentElement.dataset['density'];
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setDensity(density: Density): void {
  window.localStorage.setItem(STORAGE_KEY, density);
  apply(density);
  for (const listener of listeners) listener();
}

/** Named so the constant is not re-created, and typed without an assertion. */
function serverSnapshot(): Density {
  return 'comfortable';
}

export function useDensity(): [Density, (next: Density) => void] {
  const density = useSyncExternalStore(subscribe, read, serverSnapshot);
  return [density, useCallback((next: Density) => setDensity(next), [])];
}

/**
 * Called once before React renders. Applying it at import time rather than in an
 * effect avoids a visible reflow — the rows would otherwise be drawn at one
 * height and jump to the other.
 */
export function initDensity(): void {
  apply(read());
}
