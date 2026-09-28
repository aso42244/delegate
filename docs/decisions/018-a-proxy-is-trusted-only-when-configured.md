# 018 — A forwarded client address is believed only when configured

**Status:** accepted
**Date:** 2026-08-10

## Context

Delegate is to be reachable from outside the LAN through a **Cloudflare Tunnel**.
`cloudflared` runs on the NAS and opens an outbound connection to Cloudflare's
edge; nothing is port-forwarded and no inbound port is opened. The browser talks
HTTPS to Cloudflare, Cloudflare talks TLS to `cloudflared`, and `cloudflared`
talks plain http to Delegate over loopback on the same host.

That last hop is the one that looks alarming and is not: it never reaches a wire.
[ADR 017](017-plain-http-is-the-default-and-tls-is-optional.md) stands unchanged.

What does change is who the client appears to be. Every request now arrives from
`cloudflared`, so `request.ip` — which the sign-in rate limit is keyed on —
becomes one value for the entire internet. Ten failed passwords from anywhere
would lock out the household for five minutes, and no individual attacker could
be told apart from anyone else. The rate limit would still fire; it would just
fire at the wrong thing.

The fix is to read `X-Forwarded-For`. The difficulty is that `X-Forwarded-For` is
a header, and any client can send one.

## Decision

`TRUST_PROXY` is a configuration value, empty by default. Empty means the
connecting socket is the client. Set to `true`, or to a list of addresses and
CIDR ranges, it becomes Fastify's `trustProxy` and the forwarded address becomes
`request.ip`.

**Opt-in, and never inferred.** Auto-detecting a proxy would mean believing a
header because a header was present, which is the failure it exists to prevent.
Whether something trustworthy set that header is a fact about the deployment, so
the deployment states it.

The asymmetry is worth being explicit about, because the two mistakes are not
equally bad:

- **Not trusting a real proxy** collapses every client into one bucket. The limit
  becomes too strict — annoying, and a denial-of-service against the household,
  but nothing is _let through_.
- **Trusting a header nobody vetted** does not weaken the limit; it _removes_ it.
  Each forged address gets its own fresh bucket, so an attacker guesses passwords
  as fast as argon2 will answer, forever, by incrementing a number.

So the dangerous direction is the permissive one, and the default is the strict
one. Both directions are covered by integration tests, because a rate limit that
has quietly stopped working looks exactly like one that is working.

Turning `TRUST_PROXY` on is only correct when the application **cannot be reached
except through the proxy**. On the NAS that means the DSM firewall confines the
published port to the LAN — or, better, the port is not published at all and
`cloudflared` reaches the container over the Docker network. `deploy.sh` says
this out loud when it sees the variable set, because it cannot check it.

## Consequences

- `SESSION_COOKIE_SECURE=true` becomes correct: the browser is speaking HTTPS to
  Cloudflare even though the origin is not. `deploy.sh` previously refused this
  without a local certificate, and now accepts `TRUST_PROXY` as the deployment
  asserting that TLS is terminated upstream.
- `TRUSTED_ORIGINS` may need the tunnel hostname. The CSRF origin check compares
  `Origin` against the `Host` header; `cloudflared` forwards the original `Host`
  by default, so it usually agrees on its own, but a tunnel configured with
  `--http-host-header` rewrites it and the check would then refuse every save.
- The application logs a warning at boot when a proxy is trusted while
  `require_totp` is off — that combination is a password-only sign-in page on the
  public internet. A warning rather than a refusal, because the household may be
  mid-enrolment and refusing to start would lock them out of the screen where
  they fix it.
- **Cloudflare Access is deliberately not part of this.** It would put an identity
  gate at the edge, so nothing unauthenticated ever reaches the NAS at all, and
  the sign-in page would not be on the public internet. The owner has recorded it
  as a future request instead. What stands in its place is the rate limit, the
  second factor, and argon2id — which is a real answer, but it is answering
  attempts that arrive rather than preventing them from arriving.
- Cloudflare terminates TLS, so Cloudflare can see this household's financial
  data in plaintext. Inherent to the tunnel model and accepted knowingly; the
  alternative that avoids it is a private mesh such as Tailscale, which trades a
  third party seeing content for a third party seeing metadata.
