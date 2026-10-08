# 082. Delegate is reached privately, not from the public internet

**Status:** accepted
**Date:** 2026-10-07

Supersedes hard constraint 5 in `docs/handoff.md` ("reachable from outside only
through a Cloudflare Tunnel, never … a DSM reverse proxy"), by the maintainer's
decision. Amends [ADR 018](018-a-proxy-is-trusted-only-when-configured.md) and
[`docs/remote-access.md`](../remote-access.md), which describe the tunnel as the
way in.

## Context

The tunnel put Delegate's sign-in page on the public internet, with Cloudflare
terminating TLS in front of it. What stood between a stranger and the
household's finances was the password, the second factor and the rate limit.
Everyone who uses Delegate is already on the household's Tailscale network or at
home, so the public door served nobody who lacked a private one.

## Decision

**As of 2026-10-07, Delegate has no public address.** Its hostname was removed
from the Cloudflare Tunnel and has no public DNS record.

- **The household reaches it over Tailscale or on the home LAN.** The LAN's
  DNS resolver (AdGuard) answers the household's hostname with the NAS's private
  address.
- **DSM's reverse proxy serves HTTPS** with a Let's Encrypt certificate for that
  hostname, and forwards to Delegate's published port. This is the DSM reverse
  proxy the old constraint ruled out. It is allowed now because it faces only the
  private network, never the internet.
- **Nothing in Delegate changed.** The hostname, the cookies, `TRUSTED_ORIGINS`
  and `.env` are as they were, so sessions, the CSRF check and the secure cookie
  behave exactly as before.
- **Eventide is unchanged too.** It still reads the read door (ADRs 069, 070, 081) through `host.docker.internal` on the same NAS, which never went through
  the tunnel.

## Consequences

- No port forward and no public DNS record, now as before. A future public
  door, whether a tunnel, the onion service (ADR 027) or anything else, is a new
  decision rather than a return to the default.
- `TRUST_PROXY` still has to be paired with a confined port (ADR 018). The
  attackers it could let through are now only those already on the LAN or the
  tailnet, which is a far smaller set, but the rule is the same.
- `docs/remote-access.md` describes the tunnel, which is no longer in use. It is
  kept, marked as such, because the reasoning in it applies to any future public
  door.
- The host's specifics (the hostname and the private addresses) are recorded
  outside this public repository, under hard constraint 4.
