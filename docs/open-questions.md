# Open questions

Phase-gated. Questions that belong to a later phase are recorded here and asked
when that phase begins, rather than interrupting the current one.

Answered questions are moved to `docs/decisions/` as ADRs, not deleted from
history.

---

## Phase 1 — MVP

- **Which host port should the app publish?** `HOST_PORT` defaults to `8088` to
  stay clear of the existing Sure container. Needs confirming against what is
  already in use.
- **How much memory can Postgres have?** The NAS has 6 GB total and is already
  running the Sure container and DSM itself. Postgres 16's defaults assume far
  more, so `shared_buffers` and `work_mem` want pinning explicitly in the Compose
  file rather than left to chance on a 2-core box.
- **Where should nightly `pg_dump` output live on the NAS?** A shared folder path
  for `BACKUP_DIR`, and confirmation that it is included in whatever off-device
  backup already exists — a dump sitting on the same disk as the database is not
  a backup.
- **Is 30 days the right dump retention?** Currently `BACKUP_RETENTION_DAYS=30`.
- **SimpleFIN access URL.** Needed in `.env` before the first sync can be
  exercised against anything real. Until then the sync path is tested against
  recorded fixtures.
- **Is `$5.00` the right identity tolerance?** It is the default and configurable
  in Settings; worth revisiting once real drift is visible.

## Phase 2 — Full functionality

- **Bitcoin quantity.** Held in satoshis. The actual figure goes in the app, never
  in the repository.
- **Which historical Bitcoin price should a day with no reading use** — the
  previous day's close, or a gap in the chart? Carrying the previous close forward
  is the current plan, flagged stale, on the grounds that a gap in a net worth
  chart reads as "we lost the money" rather than "we lost the price".
- **Property staleness interval.** 3 months and 180 days were both named as
  examples. Which, per property?
- **Insights widget default set.** Which of the twelve widgets should be on for a
  brand-new user, and in what order?
- **Grouping colours.** The restraint required ("not in my face") is easier to
  judge against real data. A 3px left rail is the current plan.

## Phase 3 — Security hardening

- **What hostname and TLS approach on the LAN?** WebAuthn requires a secure
  context, so passkeys cannot be built at all over plain `http://192.168.x.x`.
  This has to be sequenced first. Options are an internal CA, or a real domain
  with DNS-01 certificates resolving to a private address.
- **Who holds the TOTP recovery codes, and where?** Mandatory 2FA on every account
  means a lost phone locks someone out of the household budget.
- **Cloudflare Access policy** — which identity provider, and which email
  addresses are allowed through the edge?
- **Does the household want session expiry shorter than 7 days** once the app is
  reachable from outside the LAN?

## Phase 4 — UI polish

- **Mobile: which surfaces actually matter on a phone?** Categorizing transactions
  from the sofa is plausible; typing sixty delegations is not. Worth knowing before
  the responsive work, so effort goes to the right screens.
- **Keyboard shortcut scheme** — is there an existing muscle memory from the
  spreadsheet worth matching?
