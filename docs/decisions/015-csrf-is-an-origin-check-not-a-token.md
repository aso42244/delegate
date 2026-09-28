# 015 — CSRF protection is an origin check, not a double-submit token

**Status:** accepted
**Date:** 2026-08-09

## Context

§10 lists CSRF protection among the Phase 3 requirements. The attack is specific:
a page on another site causes the household's browser to issue a state-changing
request to Delegate, and the browser attaches the session cookie because it
belongs to this origin. Delegate is a poor application to lose that argument in —
a forged request can move money between delegations or archive an account.

The conventional answer is a double-submit token: a random value in a readable
cookie, echoed by the client in a header, compared on the server.

## Decision

Two layers, either sufficient alone:

1. **`SameSite=Lax` on the session cookie** (already in place, ADR 008), so the
   browser does not attach it to cross-site form posts.
2. **An origin check** on every request whose method is not GET, HEAD or OPTIONS.
   `Origin` is compared against the server's own `Host`, plus anything listed in
   `TRUSTED_ORIGINS`. `Referer` is the fallback when `Origin` is absent.

No token. The reason is maintenance, not cryptography: a double-submit token
needs the client to read and echo it on **every** mutation, which is plumbing
that can be forgotten on exactly one new call site — and when it is forgotten the
failure is silent rather than loud. The origin check has no per-call-site surface
at all. It cannot be forgotten because there is nothing to remember, and it is
enforced in one `onRequest` hook that no route can opt out of by omission.

**A request with no `Origin` and no `Referer` is allowed.** This looks like a
hole and is not. The Fetch standard has browsers send `Origin` on every request
whose method is not GET or HEAD, same-site included, and page script cannot
remove it. A browser making a forged request therefore always carries one. A
request arriving with neither header did not come from a browser, so it cannot be
carrying a cookie a browser attached on someone else's behalf — which is the
whole attack. It also leaves `curl` and the test suites working without ceremony.

Only the host is compared, not the scheme. The application is served over plain
http on the LAN today; requiring https would refuse every real request, and
requiring http would have to be undone the moment TLS lands.

## Consequences

- Putting Delegate behind a reverse proxy that presents a different name requires
  adding that name to `TRUSTED_ORIGINS`. Without it, every mutation is refused
  with `cross_origin_refused` — loud, and the log line names the origin and host
  that disagreed.
- A native or scripted client needs no token to talk to the API. That is the
  intended trade: the threat model here is ambient browser credentials, and a
  scripted client has none.
- If Delegate ever serves a cross-origin browser client, this decision has to be
  revisited alongside CORS, which it currently does not enable at all.
