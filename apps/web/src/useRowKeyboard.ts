import { useCallback, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Keyboard navigation for a list of rows.
 *
 * Both `j`/`k` and the arrow keys, because both are muscle memory for somebody
 * and neither costs anything to support. A roving tabindex rather than one stop
 * per row: Tab should move past the whole table, not through sixty transactions.
 *
 * The one rule that matters: **a keystroke inside a form field belongs to the
 * field.** Every row here contains a text input for categorising, and someone
 * typing "jam" into it must get "jam" rather than three rows of movement. So
 * anything originating from an input, textarea, select or editable element is
 * left entirely alone.
 */

interface RowKeyboard {
  /** The row that currently holds the tab stop, or -1 before anything is focused. */
  readonly index: number;
  /** Spread onto each `<tr>`. */
  readonly rowProps: (index: number) => {
    tabIndex: number;
    ref: (element: HTMLTableRowElement | null) => void;
    onFocus: () => void;
  };
  /** Put on the `<tbody>`; keys bubble up from the rows. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

function isFromFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function useRowKeyboard(
  count: number,
  handlers: {
    /** Enter on a focused row — used to step into the row's own control. */
    readonly onActivate?: (index: number) => void;
    /** Space on a focused row, for selection. */
    readonly onToggle?: (index: number) => void;
  } = {},
): RowKeyboard {
  const [index, setIndex] = useState(-1);
  const rows = useRef<(HTMLTableRowElement | null)[]>([]);

  const move = useCallback((next: number) => {
    setIndex(next);
    rows.current[next]?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (isFromFormField(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (count === 0) return;

      // Clamped rather than wrapped. Wrapping from the last row to the first
      // silently moves the eye to the other end of a long queue.
      const current = index < 0 ? 0 : index;

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          event.preventDefault();
          move(Math.min(current + 1, count - 1));
          return;
        case 'k':
        case 'ArrowUp':
          event.preventDefault();
          move(Math.max(current - 1, 0));
          return;
        case 'Home':
          event.preventDefault();
          move(0);
          return;
        case 'End':
          event.preventDefault();
          move(count - 1);
          return;
        case 'Enter':
          if (index >= 0 && handlers.onActivate) {
            event.preventDefault();
            handlers.onActivate(index);
          }
          return;
        case ' ':
          if (index >= 0 && handlers.onToggle) {
            event.preventDefault();
            handlers.onToggle(index);
          }
          return;
        default:
      }
    },
    [count, index, move, handlers],
  );

  const rowProps = useCallback(
    (position: number) => ({
      // Exactly one row is tabbable at a time; -1 before anything has been
      // focused means the first row takes the tab stop.
      tabIndex: position === (index < 0 ? 0 : index) ? 0 : -1,
      ref: (element: HTMLTableRowElement | null) => {
        rows.current[position] = element;
      },
      // Clicking a row should also move the tab stop, or the next `j` jumps back
      // to wherever the keyboard last was.
      onFocus: () => setIndex(position),
    }),
    [index],
  );

  return { index, rowProps, onKeyDown };
}
