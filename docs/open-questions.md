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
- ~~**Cloudflare Access policy.**~~ Declined for now and recorded as a future
  feature request. The tunnel goes ahead without it
  ([ADR 018](decisions/018-a-proxy-is-trusted-only-when-configured.md)).
- **Does the household want session expiry shorter than 7 days?** Defensible on a
  LAN; less so once the tunnel is up and the sign-in page is public.

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

## Insights and snapshots

Not phase-gated: this is current work, and these are the questions it raised
and deliberately did not answer.

- **Should the domain compute dates in the household's zone rather than UTC?**
  [ADR 036](decisions/036-the-schedule-timezone-is-a-setting.md) deliberately
  limited the zone setting to _when jobs fire_. Every date the domain computes is
  still UTC, which means a charge made at 8pm Central files under the next day.
  Arguably wrong, and arguably worth fixing — but it moves which day a
  transaction posted on, which day a valuation is as-of, and which day a Bitcoin
  close belongs to, all of which are stored. That is a migration through live
  financial data and belongs on its own branch with its own ADR, not folded into
  a feature about charts.
- **Is 03:10 the right hour for the snapshot job?** It is offset from the hourly
  sync at :00 for the same reason the price fetch sits at :05 — two cores. It is
  also outside 02:00–02:59, which does not exist on the spring-forward morning.
  Worth knowing: `BACKUP_CRON` defaults to `30 2 * * *`, which **is** inside that
  hour, so the nightly dump can be skipped one night a year in a DST zone. Not
  introduced here, and not fixed here.
- **Should a snapshot be taken before or after the nightly dump?** It currently
  lands after, so a restore from that night's dump is always missing the most
  recent day. Harmless — the gap-filler rebuilds it — but it means the dump is
  never quite a complete picture of what the app had shown.
