import { useSyncExternalStore } from 'react';

/**
 * The part of the window that is actually on screen.
 *
 * `position: fixed` is laid out against the *layout* viewport, and on iOS the
 * layout viewport does not shrink when the software keyboard comes up — the
 * keyboard is drawn over the page, not beside it. So a sheet anchored to the
 * bottom of the screen is anchored behind the keyboard: measured at 390×844
 * with the keys taking the lower 414px, the categorization sheet ran from y=264
 * to y=844 and only its first option was above the fold. Its list and both its
 * buttons were off-screen with no way to reach them.
 *
 * The visual viewport is the visible rectangle, and `offsetTop` is that
 * rectangle's offset inside the layout viewport — so a fixed element given this
 * top and this height covers exactly what the user can see, keyboard or no
 * keyboard. On a pointer this is the whole window and the numbers are the ones
 * the element would have had anyway.
 */

export interface ViewportRect {
  /** Distance from the top of the layout viewport, in CSS pixels. */
  readonly top: number;
  readonly height: number;
}

/*
 * The snapshot is a string rather than an object because `useSyncExternalStore`
 * compares snapshots by identity: a fresh object every call is a fresh identity
 * every call, and React would loop. Parsing happens after the comparison.
 */
function snapshot(): string {
  const viewport = window.visualViewport;
  return viewport ? `${viewport.offsetTop}:${viewport.height}` : '';
}

function subscribe(listener: () => void): () => void {
  const viewport = typeof window === 'undefined' ? null : window.visualViewport;
  if (!viewport) return () => undefined;

  // `resize` is the keyboard opening and closing; `scroll` is Safari sliding the
  // visible rectangle up to reveal a focused field, which moves it without
  // changing its size.
  viewport.addEventListener('resize', listener);
  viewport.addEventListener('scroll', listener);
  return () => {
    viewport.removeEventListener('resize', listener);
    viewport.removeEventListener('scroll', listener);
  };
}

/** `null` where the browser has no visual viewport, which means: don't override. */
export function useVisualViewport(): ViewportRect | null {
  const key = useSyncExternalStore(
    subscribe,
    () => (typeof window === 'undefined' ? '' : snapshot()),
    () => '',
  );
  if (key === '') return null;

  const [top, height] = key.split(':');
  return { top: Number(top), height: Number(height) };
}
