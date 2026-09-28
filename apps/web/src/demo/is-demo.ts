/**
 * Whether the page being looked at is the demo.
 *
 * The demo is a *route*, not a deployment: `/demo/overview` is the same
 * application, the same components and the same session, drawing invented
 * numbers. So this is a fact about the URL and nothing else — there is no flag
 * to set, no second container to run and no database to build.
 *
 * Read from `location` rather than from a context because the one place that
 * needs it most is not a component: the single `fetch` every request goes
 * through, which answers from a fixture instead of the server when the page
 * asking is a demo page.
 */

/** The prefix every demo page lives under. */
export const DEMO_BASE = '/demo';

export function isDemoPath(pathname = globalThis.location?.pathname ?? ''): boolean {
  return pathname === DEMO_BASE || pathname.startsWith(`${DEMO_BASE}/`);
}

/**
 * The same destination, on whichever side of the demo the reader is.
 *
 * The navigation is one list of pages used twice, so a link out of the demo has
 * to stay in it — otherwise the first press of "Budget" lands somebody in their
 * own money halfway through showing somebody else's.
 */
export function pathFor(path: string, demo: boolean): string {
  return demo ? `${DEMO_BASE}${path === '/' ? '' : path}` : path;
}
