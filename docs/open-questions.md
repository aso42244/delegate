# Open questions

Phase-gated. Questions that belong to a later phase are recorded here and asked
when that phase begins, rather than interrupting the current one.

Answered questions are moved to `docs/decisions/` as ADRs, not deleted from
history.

---

## Phase 1 — MVP

- **Should `main` get a real protection rule?** GitHub only allows branch
  protection on private repositories under a paid plan, so the "never commit to
  `main`" rule is currently convention rather than something the server enforces.
  Three ways out: accept the convention, upgrade the plan, or make the repository
  public once there is a LICENSE and the no-personal-data guarantee has been
  audited. No action needed while a single person is committing.
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

- ~~**Is LAN TLS still wanted, and if so under what hostname?**~~ **Answered.**
  Plain http by default, with TLS available as a configured option —
  [ADR 017](decisions/017-plain-http-is-the-default-and-tls-is-optional.md).
- **Who holds the TOTP recovery codes, and where?** Mandatory 2FA on every account
  means a lost phone locks someone out of the household budget.
- ~~**Cloudflare Access policy.**~~ Dropped with passkeys and internet exposure;
  there is no edge to configure.
- **Does the household want session expiry shorter than 7 days?** Seven days on a
  LAN-only deployment is defensible; it would not be if that ever changed.

## Phase 4 — UI polish

- **Mobile: which surfaces actually matter on a phone?** Categorizing transactions
  from the sofa is plausible; typing sixty delegations is not. Worth knowing before
  the responsive work, so effort goes to the right screens.
- **Keyboard shortcut scheme** — is there an existing muscle memory from the
  spreadsheet worth matching?

## Phase 5 — Requests from Notion

- **Who can approve a request, and is approval a person or a Notion property?**
  The difference decides whether an attacker needs an account or a checkbox.
- **What may an approved request touch?** A blanket "build and merge" includes
  the authentication code, the migrations and the CI configuration itself. Some
  boundary has to be drawn, and drawing it in the pipeline is the only place it
  cannot be argued away by a persuasive request.
- **What must CI prove before a merge, beyond what it proves today?** The current
  suite is written against a human reading the diff. Nobody would be.
- **What happens to a request that fails?** Silence, a comment back in Notion, or
  a human in the loop — and whether a failed attempt can be retried indefinitely.
