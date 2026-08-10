# 016 — Passkeys are out of scope

**Status:** accepted
**Date:** 2026-08-09

## Context

§10 and §12 put passkeys in Phase 3, alongside TOTP. The intent was a second
factor strong enough to justify eventual internet exposure.

TOTP with recovery codes has since shipped ([ADR 014](014-the-second-factor-step-uses-a-signed-challenge-not-a-session.md)).
That covers the threat passkeys were there for: a stolen password no longer opens
the budget.

What passkeys would add on top is resistance to **phishing** — a WebAuthn
credential is bound to an origin, so a convincing fake login page cannot harvest
one, whereas a TOTP code typed into that page works for thirty seconds. Real, but
narrow here: this is a two-person household application on a private network with
no public URL to impersonate, and both users know the only address it lives at.

What passkeys would cost is not narrow. WebAuthn needs a credential store, an
attestation and assertion flow, registration and recovery paths for a lost
authenticator, a cross-device story for two people on phones and laptops, and a
fallback that must itself be as strong as the thing it falls back from — or the
fallback becomes the attack. That is a substantial subsystem to keep correct for
the rest of the application's life.

## Decision

Passkeys are removed from the plan. TOTP is the second factor.

This overrides §10 and §12, which is what an ADR is for.

The trade being accepted, stated plainly so a future reader does not have to
reconstruct it: **Delegate remains phishable.** Someone who can get a household
member to type their password and a live code into a page they control gets in.
Mitigating that would need passkeys or something equivalent, and if the
application's exposure ever changes — a public hostname, more users, anything
that makes impersonating the login page worthwhile — this decision should be
reopened rather than inherited.

## Consequences

- The rationale that sequenced **TLS first within Phase 3** is gone. TLS was
  ordered ahead of passkeys because WebAuthn requires a secure context. Whether
  TLS is still wanted is now a separate question on its own merits — it is not,
  and never was, only a passkey prerequisite. It is what keeps passwords, TOTP
  codes and the session cookie from crossing the LAN in clear text.
- `docs/open-questions.md` no longer needs a hostname decision _for passkeys_. It
  still needs one if TLS goes ahead.
- Nothing built so far assumed passkeys were coming; there is no code to remove.
