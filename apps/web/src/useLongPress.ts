import { useEffect, type RefObject } from 'react';

/**
 * Touch-and-hold on an element, for opening a row menu on a phone.
 *
 * Touch only, deliberately. A mouse has hover to reveal the `⋯`, and a keyboard
 * has focus; neither needs this, and binding it to the mouse would make an
 * ordinary slow click do something surprising.
 *
 * The three ways a press stops being a press, each of which has to cancel it or
 * the menu opens in the middle of something else:
 *
 * - **Moving.** A finger that travels more than a few pixels is scrolling the
 *   page, not holding a row.
 * - **Lifting.** A short tap is a tap.
 * - **The system taking over.** `touchcancel` fires when the browser claims the
 *   gesture, which is exactly when the menu should not appear.
 */

/** Long enough not to fire on a tap, short enough not to feel broken. */
const HOLD_MS = 500;

/** A finger this far from where it started is scrolling. */
const MOVE_TOLERANCE_PX = 10;

export function useLongPress(
  target: RefObject<HTMLElement | null>,
  onLongPress: () => void,
  enabled = true,
): void {
  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let origin: { x: number; y: number } | null = null;
    let fired = false;

    function cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      origin = null;
    }

    function onTouchStart(event: TouchEvent): void {
      const touch = event.touches[0];
      if (!touch) return;

      fired = false;
      origin = { x: touch.clientX, y: touch.clientY };
      timer = setTimeout(() => {
        fired = true;
        origin = null;
        onLongPress();
      }, HOLD_MS);
    }

    function onTouchMove(event: TouchEvent): void {
      const touch = event.touches[0];
      if (!touch || !origin) return;

      const moved =
        Math.abs(touch.clientX - origin.x) > MOVE_TOLERANCE_PX ||
        Math.abs(touch.clientY - origin.y) > MOVE_TOLERANCE_PX;
      if (moved) cancel();
    }

    /**
     * Suppress the platform's own long-press menu — text selection on Android,
     * the callout on iOS — but only for the press this hook actually handled.
     * Blanket-preventing it would take away selecting a description to copy it.
     */
    function onContextMenu(event: Event): void {
      if (fired) event.preventDefault();
    }

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('touchend', cancel);
    element.addEventListener('touchcancel', cancel);
    element.addEventListener('contextmenu', onContextMenu);

    return () => {
      cancel();
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', cancel);
      element.removeEventListener('touchcancel', cancel);
      element.removeEventListener('contextmenu', onContextMenu);
    };
  }, [target, onLongPress, enabled]);
}
