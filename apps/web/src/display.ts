import { useCallback, useSyncExternalStore } from 'react';

/**
 * Row density: 40px comfortable, 32px compact, 28px dense.
 *
 * Compact is the default. Forty was, on the reasoning that legibility comes
 * first — but the type size never changed with this setting, so the choice was
 * only ever about how much air sits around the same words. On a budget whose
 * whole job is a column of figures read together, eight extra pixels a row is
 * two fewer envelopes on screen and nothing gained.
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

export type Density = 'comfortable' | 'compact' | 'dense';

const DENSITIES: readonly Density[] = ['comfortable', 'compact', 'dense'];

/** What an unset or unrecognised stored value means. */
const DEFAULT_DENSITY: Density = 'compact';

const STORAGE_KEY = 'budget.display.density';

const listeners = new Set<() => void>();

function read(): Density {
  if (typeof window === 'undefined') return DEFAULT_DENSITY;

  // Anything unrecognised falls back rather than being trusted: a value written
  // by an older version, or by hand, must not leave the interface with no row
  // height at all.
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return DENSITIES.includes(stored as Density) ? (stored as Density) : DEFAULT_DENSITY;
}

/**
 * The stylesheet keys off `data-density` on the root element, so the whole
 * interface changes at once without a single component knowing the number.
 */
function apply(density: Density): void {
  if (typeof document === 'undefined') return;
  // Always stamped, including the default. With three values, leaving the
  // attribute off for one of them means the stylesheet has to encode which one
  // that is in two places.
  document.documentElement.dataset['density'] = density;
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
  return DEFAULT_DENSITY;
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
