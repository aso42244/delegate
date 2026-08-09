# 014 — The second-factor step uses a signed challenge, not a half-authenticated session

**Status:** accepted
**Date:** 2026-08-09

## Context

§10 requires TOTP on every account before any internet exposure. A two-step
sign-in has a state in the middle: the password has been accepted, the code has
not. That state has to live somewhere between the two requests.

The obvious place is the session. It is the wrong place here. `PrismaSessionStore`
refuses to write a row without a `user_id` (ADR 008), and it does so deliberately
— the constraint is what stops an unauthenticated request from creating session
rows at all. Relaxing it to carry a pending sign-in would remove the property it
exists for, and would put a row in the sessions table for someone who is, by
definition, not signed in.

The alternative considered was a second table for pending sign-ins. It works, but
it adds a table, a cleanup job, and a second thing that can be replayed, all to
hold a value for five minutes.

## Decision

`POST /api/auth/login` returns `{ secondFactorRequired: true, challenge }` and
establishes **no session** when the account has a confirmed second factor. The
challenge is a base64url payload of `{ userId, exp }` with an HMAC-SHA256
signature keyed from `SESSION_SECRET`, domain-separated by the prefix
`second-factor:` so it can never be confused with any other use of that key. It
expires in five minutes and is accepted by exactly one route,
`POST /api/auth/second-factor`, which verifies the code and only then regenerates
the session.

Nothing about the challenge is a credential on its own. It names an account and
proves the server accepted a password for it recently; without a valid code it
opens nothing.

Two details that are load-bearing:

- **Every rejection is identical.** Malformed, wrong signature, expired — all
  raise the same error. A token that reported which part failed would tell an
  attacker which part of a forgery to keep.
- **The account is re-read at exchange time.** It may have been archived in the
  minutes since the password was accepted, and a challenge is not a session, so
  nothing else would notice.

Recovery codes are stored as argon2id hashes and marked `used_at` rather than
deleted, per the project rule that nothing is hard-deleted. The TOTP secret is
stored encrypted with the same AES-256-GCM scheme as the SimpleFIN credential
(ADR 011), for the same reason: the nightly `pg_dump` is the copy most likely to
leave the device, and a plaintext secret in a stolen dump is a working second
factor.

## Consequences

- A half-finished sign-in leaves no server-side state. Abandoning it costs
  nothing and cleans up nothing.
- The client holds the challenge in component state, so a page reload restarts
  the sign-in — the correct outcome for a half-finished one.
- Rotating `SESSION_SECRET` invalidates in-flight challenges. They last five
  minutes; this is not worth designing around.
- Requiring the second factor of everyone is a setting (`require_totp`), off by
  default, and refuses to turn on while any active account would be locked out
  by it. Shipping the mechanism must not brick a running deployment in the gap
  between the code landing and the household enrolling.
