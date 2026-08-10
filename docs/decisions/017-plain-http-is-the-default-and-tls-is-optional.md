# 017 — Plain http is the default; TLS is optional and operator-configured

**Status:** accepted
**Date:** 2026-08-09

## Context

§12 puts LAN TLS in Phase 3 and sequences it first, because WebAuthn requires a
secure context. [ADR 016](016-passkeys-are-out-of-scope.md) removed passkeys, so
that reason is gone. The remaining reason for TLS is the one that was always
there and was never the one written down: over plain http, every password, every
TOTP code and the session cookie itself are readable by anything else on the
network.

Delegate has no _technical_ requirement for a secure context. Money is computed
on the server, and nothing in the browser does cryptography of its own. This is
worth stating because Actual Budget, the
nearest comparable self-hosted application, **does** require HTTPS for exactly
that reason and exempts only `localhost`. Sure, the other application already
running on this NAS, ships plain http and says so: its Docker guide notes the
instance "runs in plain HTTP," and that if you are "running locally and don't
care much about security, you can skip this step."

So there is no convention to inherit. Self-hosted projects sit at both poles.

The options weighed:

- **Tailscale**, which issues a genuinely trusted certificate on a `*.ts.net`
  name via DNS-01 and renews it automatically, with nothing to install on any
  device. Technically the strongest answer, and it would likely replace the
  Cloudflare Tunnel item too — but it makes a two-person household application
  depend on a third-party coordination service, and publishes machine names to a
  public certificate-transparency ledger.
- **A self-signed certificate**, which encrypts the traffic with no third party
  involved, at the cost of a browser warning on every device until the
  certificate is trusted there.
- **Plain http**, which is what the household has been running for its other
  finance application without incident.

## Decision

**Plain http is the default.** The owner chose it, with the trade stated: on a
home network he controls, with no internet exposure, the exposure is other
devices on that LAN.

**TLS is supported, not required.** Setting `TLS_CERT_PATH` and `TLS_KEY_PATH`
makes the application terminate TLS itself. `scripts/make-tls-cert.sh` generates
a suitable self-signed certificate with the right Subject Alternative Names —
including bare IP addresses, which modern browsers read from the SAN list and
nowhere else.

Supporting rules, each because its absence fails quietly:

- **Both paths or neither.** The application refuses to start on half a
  configuration, and `deploy.sh` catches it before replacing the container. Half
  a TLS configuration serves plain http from a deployment whose settings say it
  is encrypted, which is worse than no TLS — nobody would look again.
- **The transport is logged at every boot**, plainly, including the warning when
  it is plain http. A default is only a decision while it stays visible.
- **`SESSION_COOKIE_SECURE=true` with no TLS is refused by `deploy.sh`.** A
  browser never sends a Secure cookie over plain http, so sign-in fails with
  nothing on screen to explain it. The application only warns, because something
  in front of it may legitimately be terminating TLS.
- **CI starts the same image over TLS and proves it negotiates**, then proves
  plain http is refused on that port. The default path is exercised constantly;
  the optional one would otherwise be exercised for the first time on the NAS.

## Consequences

- Passwords and TOTP codes cross the LAN in clear text in the default
  configuration. This is the accepted trade, not an oversight, and the rate
  limiting and second factor already shipped do nothing about it — an observer on
  the network reads the code as it is typed.
- **Internet exposure is off the table** while this stands. The Phase 3 rule that
  nothing is exposed until the phase ships in full still holds, and plain http
  cannot satisfy it. Anything that changes that — Cloudflare Tunnel, Tailscale,
  a reverse proxy — reopens this decision.
- The container image is unchanged between the two modes. The same digest serves
  either, decided only by configuration, so turning TLS on is not a redeploy of
  something different.
- If the household ever adds devices it does not fully trust — a guest network is
  not the same network, but an IoT device usually is — this should be revisited.
