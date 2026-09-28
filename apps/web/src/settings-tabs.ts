import { useCallback, useSyncExternalStore } from 'react';

/**
 * Where the Settings sections are listed.
 *
 * `top` is the tab row this page has always had. `side` puts the same list in a
 * rail immediately right of the main sidebar, which is what a tall screen wants
 * once there are eight of them: a horizontal row spends the width the cards need
 * and reads left to right, while a column reads down and costs nothing that was
 * being used.
 *
 * **Per device, not per household**, like row height, the theme and the budget
 * layout. It describes the screen somebody is looking at, and one person's
 * choice should not follow the other to their own laptop.
 *
 * `useSyncExternalStore` rather than `useState`, for the same reason those use
 * it: the control that changes this lives on a different tab from the thing it
 * changes, so every reader has to re-render together.
 */

export type SettingsTabs = 'top' | 'side';

const PLACEMENTS: readonly SettingsTabs[] = ['top', 'side'];

/** What an unset or unrecognised stored value means. */
const DEFAULT_PLACEMENT: SettingsTabs = 'top';

const STORAGE_KEY = 'budget.display.settingsTabs';

const listeners = new Set<() => void>();

function read(): SettingsTabs {
  if (typeof window === 'undefined') return DEFAULT_PLACEMENT;

  // Anything unrecognised falls back rather than being trusted: a value written
  // by an older version, or by hand, must not leave the page with no navigation.
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return PLACEMENTS.includes(stored as SettingsTabs) ? (stored as SettingsTabs) : DEFAULT_PLACEMENT;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSettingsTabs(placement: SettingsTabs): void {
  window.localStorage.setItem(STORAGE_KEY, placement);
  for (const listener of listeners) listener();
}

/** Named so the constant is not re-created, and typed without an assertion. */
function serverSnapshot(): SettingsTabs {
  return DEFAULT_PLACEMENT;
}

export function useSettingsTabs(): [SettingsTabs, (placement: SettingsTabs) => void] {
  const placement = useSyncExternalStore(subscribe, read, serverSnapshot);
  const set = useCallback((next: SettingsTabs) => setSettingsTabs(next), []);
  return [placement, set];
}
