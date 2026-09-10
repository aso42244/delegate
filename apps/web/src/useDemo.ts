import { useLocation } from 'react-router-dom';
import { isDemoPath } from './demo/is-demo.js';

/**
 * Whether the page being looked at is the demo.
 *
 * A route rather than a deployment: `/demo/overview` is the same application
 * drawing invented numbers. Through `useLocation` so a component re-renders when
 * somebody navigates into or out of it — reading `window.location` directly
 * would leave the sidebar pointing at the wrong half until something else
 * happened to re-render it.
 *
 * Used to stop offering what cannot be done here. **Presentation, never
 * enforcement**: the demo has no server behind it to change, and the one fetch
 * this application makes refuses a write on a demo page outright.
 */
export function useIsDemo(): boolean {
  return isDemoPath(useLocation().pathname);
}
