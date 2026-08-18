# OWASP review, August 2026 — what was done

An external static review mapped Delegate against the OWASP Top 10:2021. This
records what was fixed, what was not, and why — so the open items are decisions
with reasons rather than things nobody got to.

## Fixed

| #   | Finding                                       | What changed                                                                                                                           |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Password change did not revoke other sessions | `changeOwnPassword` deletes every session for the account, as `resetPassword` always did. The route re-establishes the caller's.       |
| 2   | Any account could change household settings   | `PATCH /api/settings` requires `canManageSettings`. Reading stays open. Old and new values logged for the two that decide who gets in. |
| 8   | TOTP enrolment had no password step-up        | `totp/begin` requires the current password, as disabling always did.                                                                   |
| 12  | No global rate limit                          | A generous per-minute ceiling on `/api/*`, with the credential routes keeping their much stricter limit.                               |
| 13  | No `Cache-Control: no-store` on the API       | Set for `/api/*` only; the content-hashed bundle stays cacheable.                                                                      |
| 14  | No `Permissions-Policy`                       | camera, microphone, geolocation, payment and USB denied.                                                                               |
| 5   | Tor proxy was a third-party `latest` tag      | Replaced with an in-repo image: Alpine's own `tor` package, nothing else.                                                              |
| 19  | Backups had no integrity check                | A `.sha256` sidecar written beside each dump, verified by `restore.sh` **before** anything is dropped.                                 |
| 15  | _(reported)_ xpubs stored in plaintext        | **Not a finding.** Descriptors are AES-256-GCM encrypted at rest like every other secret. The report is mistaken.                      |

## Not fixed, with reasons

**#4 — the app connects to Postgres as the superuser.** Real, and worth doing.
Not done here because it is an operator action on a live database rather than a
code change: the role has to be created and granted on the running instance, and
getting it wrong locks the application out of its own data. The steps are in the
README; do them at a quiet moment, not as part of a release.

**#3 — backups are not encrypted.** The dump holds the whole financial history
and every hash. Encrypting it is right, and it changes the recovery path: a
passphrase that lives only in `.env` means a lost `.env` is a lost backup, which
can be worse than an unencrypted dump on a disk you control. It needs a decision
about where that passphrase is kept — off the NAS — before the code lands.

**#7 — one secret for sessions and at-rest encryption.** Splitting them needs a
re-key path that decrypts with the old key and re-encrypts with the new, across
TOTP secrets, the SimpleFIN credential and every wallet descriptor. Doing that
carelessly loses second factors and bank access at once. It deserves its own
change with its own rehearsal, not a corner of a security sweep.

**#6 — SSRF-shaped surfaces.** `POST /api/sync/connect` and the Bitcoin node
routes make the server fetch an operator-supplied URL, and private addresses are
_deliberately_ allowed because pointing at a node on your own network is the
recommended configuration. Both are authenticated and now
administrator-relevant. This cannot be "fixed" without removing LAN node
support; it is a documented trust boundary, and it is the first thing to revisit
if a lower-trust role ever exists.

**#17 — no Dependabot.** GitHub is a place to keep the code and nothing else
(ADR 022). The audit gate in `scripts/audit.mjs` runs in `npm run verify` and
fails on unreviewed advisories at high and above, which is the same protection
without a service running on somebody else's schedule. The cost is that nothing
watches between runs.

**#16 — floating base image tags.** Pinning needs a digest read from a registry,
which cannot be invented. Recorded in the Dockerfile and compose file with the
command to produce one, to be done at the next deliberate base bump.

**#10, #11 — absolute session lifetime, session inventory.** Both worth having.
Neither is a defect today: sessions expire on their own TTL, and a password
change now revokes every other one, which is the tool somebody actually reaches
for when they are worried.

**#20 — the second-factor challenge is replayable inside its five minutes.** It
proves only that a password was accepted moments ago, is rate limited, and still
requires a TOTP code that is now single-use. Binding it to a device is the next
increment if exposure grows.

## Deliberately unchanged

The review's own "what not to change" list is right, and this change touched none
of it: the CSRF design, per-IP rather than per-account rate limiting, the
dummy-hash enumeration defence, the plaintext-node rules, and digest-pinned
signed deploys.

# Second review, August 2026 — the low findings

A second static review against the same framework, verifying the fixes above and
adding depth. The four mediums it lists are the same four already open here.

## Fixed

**ReDoS beyond the shape check.** The heuristic catches `(a+)+` and explains
itself in the refusal, which is worth keeping — but it reads syntax, and
`(a|a)+$` is exponential with no nested quantifier in sight. Measured on this
machine, that pattern took **213 seconds** against a 120-character input.

Patterns are now _timed_ as well as read, against a ladder of increasing hostile
inputs that stops the moment a budget is spent. Escalating rather than one long
probe is the whole trick: causing catastrophic backtracking is how you detect it,
and a single long probe would have made the check a worse denial of service than
the pattern it was looking for. Bounded now to a few hundred milliseconds in the
worst case.

**Database credentials off the command line.** `pg_dump`, `pg_restore` and `psql`
took a connection URL as an argument, readable by anything that could run `ps`
inside the container for as long as a dump ran. They read `PG*` from the
environment now, with percent-decoding — a password containing `@` or `:` has to
be encoded for the URL to parse, and `PGPASSWORD` is literal, so skipping that
would have broken exactly the deployments with the strongest passwords.

Running the real script found a second bug in the same area: `verify-restore.sh`
derived the connection _before_ switching `DATABASE_URL` to the test database, so
every `psql` in it ran against the household's own data and truncated it, while
the restore went elsewhere and the comparison failed. That is why it is exercised
rather than inspected.

**The second-factor challenge is single-use.** Spent on success, not on arrival:
spending it before checking the code would make a typo in six digits cost the
password too, and buys almost nothing because the rate limit already caps a
stolen challenge at ten guesses against a million possibilities. What is
prevented is reuse _after_ it worked.

**Onion visitors get their own rate-limit bucket.** Tor does not tell the
destination who connected — that is the point of it — so every onion visitor
arrives from the tor container's address. Keyed on that, ten wrong guesses from a
stranger probing the onion would have locked out the laptop in the kitchen.
Remote visitors still share one bucket between them, which cannot be helped and
costs availability from away rather than at home.

**Test isolation, permanently.** The database reset was a hand-maintained list of
tables, and a new table left off it leaked rows into the next test — four
separate times, each surfacing as a confusing failure somewhere unrelated. It
asks the database what tables exist now. The only names left are the two pinned
singletons, which are reset in place because the application updates them by id
and never creates them.

## Still open, unchanged

The four mediums — TLS at the origin, one secret for everything, unencrypted
backups, the Postgres superuser — plus absolute session lifetime, session
inventory, digest-pinned base images and an `auth_events` table. Each is
explained above; none moved.
