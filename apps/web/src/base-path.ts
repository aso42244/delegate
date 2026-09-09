/**
 * Where this build is served from.
 *
 * `/` for a normal deployment and `/demo` for one mounted under a path on
 * somebody else's domain. Everything that builds a URL has to agree about it —
 * the router, the asset paths and every request the client makes — and a
 * disagreement between any two of them shows up as a blank page rather than as
 * an error, which is why it is one value read in one place.
 *
 * Set at **build** time, not run time: Vite has to bake it into the asset URLs
 * inside `index.html`, and those are written before a server exists to ask.
 *
 * No trailing slash, and `''` rather than `'/'` at the root — so `${BASE_PATH}/api/x`
 * is always exactly one slash, whichever it is.
 */
const configured = import.meta.env.BASE_URL ?? '/';

export const BASE_PATH = configured === '/' ? '' : configured.replace(/\/$/, '');

/** A path on this deployment, from a path in the application. */
export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}
