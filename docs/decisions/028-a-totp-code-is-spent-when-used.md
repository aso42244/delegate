# 028. A TOTP code is spent when it is used

**Status:** accepted
**Date:** 2026-08-18

## Context

`verifySecondFactor` accepted a code for one period either side of now — about
ninety seconds of validity — and recorded nothing about it afterwards. The same
six digits worked as many times as they were offered inside that window.

Recovery codes were already single-use, stamped `used_at`. TOTP was not, and the
asymmetry was an oversight rather than a decision.

It matters more than it looks because of where the codes travel. With TLS
terminated by a tunnel provider, "somebody else saw the code" is not a
hypothetical: it is a description of normal operation.

## Decision

A `totp_used_codes` row per accepted code, holding an HMAC of it and an expiry
four minutes out.

**The unique index is the mechanism**, not a check before a write. Two requests
arriving with the same code at the same moment would both pass a read-then-write;
only one of them can win an insert. A failed insert _is_ the refusal.

**An HMAC rather than the code.** Six digits are worthless ninety seconds later,
so this is not protecting much — but there is no reason to write live codes into
a nightly database dump either, and the domain-separated HMAC costs nothing.

**Swept on use rather than on a schedule.** The rows matter for four minutes, and
a sign-in is exactly the moment there is an expired one worth deleting. A second
scheduled job to delete a handful of rows would be more machinery than the
problem.

## Consequences

A code is now genuinely one-time, matching recovery codes.

An authenticator whose clock is far enough out to reuse a period boundary is
unaffected: the tolerance is unchanged, and only _reuse of the same code_ is
refused rather than any code from that period.

The table is per-user and self-expiring, so it does not grow.
