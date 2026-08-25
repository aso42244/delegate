import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Icon, PAGES } from './Sidebar.jsx';

/**
 * Navigation on a phone: the five destinations, along the bottom.
 *
 * The same `PAGES` and the same icons the sidebar uses — this is that sidebar
 * rotated, not a second navigation model with its own copy of the list to drift
 * out of step.
 *
 * Below `sm` only. A 232px sidebar on a 390px screen takes 59% of the width
 * before a number is drawn; 56px of height and an inset costs 9% of a phone's
 * height and puts every destination under a thumb.
 */

/**
 * How far the page must move before the bar reacts.
 *
 * Momentum scrolling reports a stream of tiny deltas in both directions, and a
 * bar that answers each one flickers. Eight pixels is below anything deliberate
 * and above the noise.
 */
const THRESHOLD = 8;

/**
 * Hides going down, returns coming up.
 *
 * The gesture people already make to see more of a list gives the list more
 * room, and the one they make to go back to the top brings navigation with it.
 *
 * Two rules keep it from being annoying. It never hides near the top, where
 * there is nothing to reclaim and hiding reads as a glitch. And it always
 * returns on any upward movement, so getting it back is never a hunt — which is
 * what separates this from a bar that hides on a timer.
 */
function useHideOnScrollDown(scroller: HTMLElement | null): boolean {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    if (!scroller) return;

    lastY.current = scroller.scrollTop;

    function onScroll(): void {
      if (!scroller) return;
      const y = scroller.scrollTop;
      const delta = y - lastY.current;
      if (Math.abs(delta) < THRESHOLD) return;

      lastY.current = y;
      // Never hidden in the first screenful: there is nothing to gain, and a bar
      // that vanishes as soon as the page twitches reads as a fault.
      setHidden(delta > 0 && y > 64);
    }

    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scroller]);

  return hidden;
}

export function TabBar({ scroller }: { readonly scroller: HTMLElement | null }): ReactNode {
  const hidden = useHideOnScrollDown(scroller);

  return (
    <nav
      aria-label="Pages"
      // `translate-y-full` rather than unmounting: the bar has to be able to
      // come back without the browser rebuilding it, and a hidden landmark that
      // is still in the tree stays reachable to a screen reader, which does not
      // scroll to read.
      className={`fixed inset-x-0 bottom-0 z-20 border-t border-line bg-canvas transition-transform duration-200 sm:hidden ${
        hidden ? 'translate-y-full' : 'translate-y-0'
      }`}
      // The home-indicator inset on an iPhone. Zero everywhere else, so this
      // costs nothing on a device without one.
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="grid grid-cols-5">
        {PAGES.map((page) => (
          <NavLink
            key={page.to}
            to={page.to}
            end={page.end}
            className={({ isActive }) =>
              `flex h-14 flex-col items-center justify-center gap-1 text-label ${
                isActive ? 'text-accent' : 'text-muted'
              }`
            }
          >
            <Icon name={page.icon} />
            {page.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
