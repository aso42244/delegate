import { useCallback, useSyncExternalStore } from 'react';

/**
 * Which palette the interface is drawn in.
 *
 * Stored per device rather than on the server, for exactly the reason row
 * density is: this is a fact about the screen someone is looking at, not about
 * the household's budget. One person reading in a dark room should not put the
 * other person's phone into dark mode.
 *
 * **System is resolved here rather than in CSS.** The stylesheet carries one
 * palette per theme, keyed on `data-theme`, and this module decides which
 * attribute goes on. The alternative — a second `prefers-color-scheme` block —
 * means two copies of the same twenty-five colours, and a media query cannot be
 * added to a selector list to avoid that. Two copies of a palette drift, and the
 * drift shows up as one screen in the wrong grey.
 *
 * **`system` is the only choice that resolves to something else.** It means
 * "follow the device", and the device has exactly two opinions. Every other
 * choice is stamped as itself: a theme is a palette somebody picked, and no
 * media query gets to overrule it.
 */

export type ThemeChoice = 'system' | 'light' | 'dark' | 'ledger' | 'reading' | 'contrast';

/** What actually reaches `data-theme`. `system` never does. */
export type ThemeName = Exclude<ThemeChoice, 'system'>;

const CHOICES: readonly ThemeChoice[] = [
  'system',
  'light',
  'dark',
  'ledger',
  'reading',
  'contrast',
];

/** What an unset or unrecognised stored value means. */
const DEFAULT_CHOICE: ThemeChoice = 'system';

const STORAGE_KEY = 'budget.display.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

const listeners = new Set<() => void>();

function read(): ThemeChoice {
  if (typeof window === 'undefined') return DEFAULT_CHOICE;

  // Anything unrecognised falls back rather than being trusted: a value written
  // by an older version, or by hand, must not leave the interface with no theme.
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return CHOICES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : DEFAULT_CHOICE;
}

/** What the device is asking for, when the choice is to follow it. */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/** The choice resolved to something the stylesheet can key on. */
export function resolveTheme(choice: ThemeChoice): ThemeName {
  if (choice === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return choice;
}

function apply(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  // Always stamped, including light. The pre-paint fallback in styles.css keys
  // on the attribute being *absent*, so leaving it off for light would let a
  // dark-preferring device keep a dark ground under a light palette.
  document.documentElement.dataset['theme'] = resolveTheme(choice);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function setTheme(choice: ThemeChoice): void {
  window.localStorage.setItem(STORAGE_KEY, choice);
  apply(choice);
  notify();
}

/** Named so the constant is not re-created, and typed without an assertion. */
function serverSnapshot(): ThemeChoice {
  return DEFAULT_CHOICE;
}

export function useTheme(): [ThemeChoice, (next: ThemeChoice) => void] {
  const choice = useSyncExternalStore(subscribe, read, serverSnapshot);
  return [choice, useCallback((next: ThemeChoice) => setTheme(next), [])];
}

/**
 * Called once before React renders, so the page is not drawn light and then
 * repainted dark.
 *
 * Also starts following the device. Without the listener, "System" would mean
 * "whatever the system said when this tab was opened" — which is wrong twice a
 * day on any machine that switches at sunset, and looks like a bug rather than a
 * setting.
 */
export function initTheme(): void {
  apply(read());

  if (typeof window === 'undefined' || !window.matchMedia) return;
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    // Only when the choice is to follow. An explicit light or dark is a decision
    // the device does not get to overrule.
    if (read() !== 'system') return;
    apply('system');
    notify();
  });
}
