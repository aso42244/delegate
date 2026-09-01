# 017 — Plain http is the default; TLS is optional and operator-configured

**Status:** accepted, amended 2026-08-18 (see the addendum)
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

## Addendum, 2026-08-18: this is no longer a LAN-only application

The consequences above were written when Delegate had no route in from outside
the house, and several of them read as if that were still true. It is not. There
are now three ways in, and the operator picks:

- **A tunnel or reverse proxy**, which terminates TLS somewhere else and speaks
  plain http to this origin. That is what the default is _for_, and it is why
  `SESSION_COOKIE_SECURE` and `TRUST_PROXY` exist.
- **A Tor onion service** (ADR 027), where the address is itself an ed25519
  public key. The connection is encrypted and authenticated end to end with no
  certificate anywhere, which is why plain http inside that tunnel is correct
  rather than a compromise.
- **Nothing at all** — the original case, unchanged.

What has _not_ changed is the last line of defence, and it got stronger rather
than weaker: two-factor authentication is required of every account by default,
a TOTP code can be spent only once (ADR 028), and remote access over Tor is
refused until somebody switches it on from the home network.

The remaining honest statement is narrow: **at the origin, on the local network,
Delegate speaks plain http by default.** Anyone already inside the house can read
a password crossing it. `scripts/make-tls-cert.sh` closes that, at the cost of a
self-signed certificate on every device. That trade is unchanged; the claim that
the application "must not leave the LAN" is retired.

---

**Amended by [ADR 042](042-delegate-installs-anywhere-in-one-line.md), 2026-09-01.**

The decision stands; the _argument_ no longer generalises. It was "Cloudflare and
Tor both encrypt from away; what remains is the LAN" — sound while every
deployment was one household's NAS, and false the moment the same image can be
run on a public VPS in one line, where it would serve passwords and two-factor
codes in clear text to anything on the path.

Plain http remains the default, because it is still right on a LAN and behind a
tunnel. What changed is that the safe path for a public address is now one line
rather than a project: `DELEGATE_DOMAIN` plus the `https` profile starts Caddy,
which gets a real certificate and renews it unattended.
