# Reaching Delegate from outside the house

Through a **Cloudflare Tunnel**. No port forwarding, no inbound port, no public
IP: `cloudflared` runs on the NAS and dials out to Cloudflare's edge.

## What is encrypted, and what is not

| Leg                                        | Transport                                       |
| ------------------------------------------ | ----------------------------------------------- |
| Browser → Cloudflare edge                  | HTTPS, Cloudflare's certificate for your domain |
| Cloudflare edge → `cloudflared` on the NAS | TLS (QUIC or HTTP/2), outbound-initiated        |
| `cloudflared` → Delegate                   | plain http, over loopback on the same host      |

Nothing crossing the internet is in the clear. The plain-http hop never reaches a
wire — it goes from one process to another on the same machine, and anything able
to observe it already has the database.

**Cloudflare terminates TLS**, which means Cloudflare can see this household's
financial data in plaintext. That is inherent to the model and accepted
knowingly ([ADR 018](decisions/018-a-proxy-is-trusted-only-when-configured.md)).
The alternative that avoids it is a private mesh such as Tailscale.

## Configuration

In `.env`:

```
TRUST_PROXY="true"
SESSION_COOKIE_SECURE="true"
TRUSTED_ORIGINS="https://budget.example.com"
```

Each one earns its place:

- **`TRUST_PROXY`** makes the sign-in rate limit count the real client rather
  than counting `cloudflared`. Without it, ten failed passwords from anywhere
  lock out the household, and no attacker can be told apart from any other.
- **`SESSION_COOKIE_SECURE`** stops the session cookie being sent over anything
  but HTTPS. The browser is speaking HTTPS even though the origin is not, so this
  is correct here and wrong on a bare LAN deployment.
- **`TRUSTED_ORIGINS`** is insurance for the CSRF check. `cloudflared` forwards
  the original `Host` header by default, in which case the check agrees on its
  own — but a tunnel configured with `--http-host-header` rewrites it, and every
  save would then be refused with `cross_origin_refused`.

## The part that is not optional

**Confine the published port before turning `TRUST_PROXY` on.**

`X-Forwarded-For` is a header, and any client can send one. If the port is
reachable directly as well as through the tunnel, trusting that header does not
weaken the rate limit — it removes it, because a forged address gets a fresh
bucket on every request and an attacker guesses passwords by incrementing a
number.

Either confine `HOST_PORT` to the LAN in the DSM firewall, or stop publishing it
at all and let `cloudflared` reach the container over the Docker network.

**Turn on the two-factor requirement.** Settings → Security, once both accounts
have enrolled. Without Cloudflare Access in front, Delegate's sign-in page is on
the public internet; what stands between a stranger and the household's finances
is the password, the second factor, and the rate limit. The application warns at
every boot while a proxy is trusted and the requirement is off.

## What Cloudflare Access would add

An identity gate at Cloudflare's edge: sign in with Google or an emailed code
_before_ any request reaches the NAS. The sign-in page would not be on the public
internet at all, and credential-stuffing traffic would never arrive.

Recorded as a future request rather than built. The difference it makes is
between refusing attempts and never receiving them.
