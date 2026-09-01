# OWASP review, September 2026 — what was done

The third external static review, against the `v0.37.0` snapshot (commit
`d42ebc2`). It found **eight items, none above low**, and confirmed that
everything the August reviews raised is either fixed or a decision with a date
on it — see [security-review-2026-08.md](security-review-2026-08.md).

This file records what was done with each one, in the same spirit as its
predecessor: **an open item here is a decision with a reason, not something
nobody got to.** Nothing from this review is outstanding.

All eight reproduced in the tree. One was described in the wrong file, and
checking the report turned up two more of the same kind.

## Fixed

| #   | Finding                                         | What changed                                                                                                                                                                              |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Enrolment-confirm TOTP code never spent         | `confirmEnrolment` claims the code through the same `claimCode` the sign-in path uses. A correct-but-spent code is now told apart from a wrong one, because the two need different words. |
| 2   | Server-side-fetch routes not administrator-only | The three that **choose a destination** are gated. The two that only use what is stored are not — see below.                                                                              |
| 3   | `169.254.0.0/16` counted as private             | Removed from `PRIVATE_HOST` and named separately as `isLinkLocalHost`, because it is refused for a different reason than a public host is.                                                |
| 4   | SimpleFIN claim POSTs to an arbitrary URL       | The decoded claim URL must be public https. Private, link-local and onion hosts are refused before anything is sent.                                                                      |
| 5   | No absolute session lifetime                    | `SESSION_ABSOLUTE_TTL_SECONDS`, 90 days, measured from `created_at` and never extended. Enforced on read and in the sweep.                                                                |
| 6   | Failed-login logs record the attempted username | The name is stored when it matches a real account, and a short keyed digest otherwise. See `domain/auth-subject.ts`.                                                                      |
| 8   | Comment drift                                   | Session pruning does not run nightly, and the session cookie is not waiting for TLS. Three comments corrected — the report located one of them in the schema; it was in the store.        |
| —   | _(not in the report)_ Access URL accepted http  | `connectWithAccessUrl` checked `https?` while its message said https. That URL carries the bank credential, so plain http meant sending it in the clear every hour.                       |

### Why finding 2 is three routes and not five

The review named five. The line drawn here is **whether the route decides where
this server sends a request**, not whether it makes one.

- **Gated** — `PUT /api/bitcoin/node` names the address every address lookup
  goes to; `POST /api/sync/connect` stores a URL the hourly job then fetches
  forever; `POST /api/sync/disconnect` silently ends the household's feed.
- **Not gated** — `POST /api/sync` and `POST /api/bitcoin/node/check` use what is
  already stored and choose nothing. Gating them would cost an ordinary account
  the ability to refresh its own budget and buy no security at all.

The second household account is a `user`, so this is not academic.

## Accepted, with reasons

**#7 — CSP has no violation reporting.** Declined. A `report-to` endpoint is an
unauthenticated write path feeding a log line, and this project's own history is
the argument against it: the nightly backup failed for weeks into a log nobody
read, and the lesson written down afterwards was to **check for the evidence a
thing leaves, not for the absence of an error**. A report endpoint is the second
kind. Meanwhile `script-src 'self'` with no inline allowance means a real
violation breaks the page visibly, which is a louder signal than a log line.

Worth revisiting if the CSP ever has to relax — an allowance is exactly the
condition where an invisible violation starts being possible.

**Backups are not encrypted.** Accepted as a decision, closing the August item
that had been deferred pending this. The dump holds everything: history, password
hashes, and the encrypted secrets.

The question was never whether encryption is better in the abstract; it is where
the passphrase lives. A passphrase only in `.env` makes a lost `.env` a lost
backup, which is worse in the failure case that actually happens — a dead NAS —
than an unencrypted dump on a disk the household controls. `/volume1/backups` is
covered by the off-NAS backup, which has its own protection.

So: **plaintext dumps, deliberately.** If this is ever reopened, the only version
worth building is one whose passphrase is kept where the onion address is kept —
off the device, and somewhere that will still exist in two years.

## Not built here

**An `auth_events` table, with a screen that shows it.** Carried open since
August, and now being built — with the Settings screen, not without it. A table
nobody queries is the dead-backup trap again; the point is a screen that answers
"has anything strange happened" unprompted, the way the backup card does.

The record of a failed attempt uses `describeAttemptedUsername`, so it inherits
finding 6's rule: a real name only when it is a real name.

## Operational, and still the owner's to run

Unchanged from August in substance, and the reason each one is not a code change
is that each acts on a live database or a live NAS.

1. **Set `DATA_ENCRYPTION_KEY` and run `secrets:rekey`.** The code shipped in
   `v0.31.0` and is rehearsed. Until it runs, the at-rest key is still derived
   from `SESSION_SECRET`.
2. **Move the live database onto the `delegate_app` role.** Fresh installs get it
   from the init script; this deployment predates it. README has the steps.
3. **Confirm the `tor-keys` volume is in the NAS backup.** Losing it does not lose
   access — it loses the onion _name_, permanently, for every device that has it.
4. **Pin the base-image digests at the next deliberate base bump.** Not now:
   pinning today means pinning a digest nobody has audited, and adding a manual
   step to every rebuild in between.

## What was explicitly left alone

The review's own "what not to change" list, agreed with in full: origin-check
CSRF, per-IP rather than per-account throttling, the plain-http default at the
origin (ADR 017), the two-level permission model, `verify.sh` as the only gate,
and archive-don't-delete with stamped reversals.

---

_Reviewed against `v0.37.0`. Prior passes: the two August 2026 reviews, recorded
in [security-review-2026-08.md](security-review-2026-08.md)._
