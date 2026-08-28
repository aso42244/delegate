# 036 — The schedule timezone is a setting, not only an environment variable

**Status:** accepted; the "and nothing else" clause below is superseded by
[ADR 037](037-a-day-is-the-households-day.md)
**Date:** 2026-08-28

## Context

`SCHEDULE_TIMEZONE` arrived in v0.30.0 as an IANA name in `.env`, defaulting to
UTC, governing when the sync, price and backup jobs fire. Its comment gives the
reason it lives there rather than in the repository:

> A household's time zone is a fact about that household, so the real value
> belongs in `.env` rather than in this repository — the same reason `APP_NAME`
> exists.

That reasoning is about **the repository**, and it is correct. It was read as
also being about **configuration mechanism**, and that part does not follow.

Two things made it worth revisiting now. The nightly snapshot job
([ADR 035](035-the-financial-picture-is-snapshotted-nightly.md)) labels its rows
for the _previous day_, so the zone stops being only a convenience about when a
dump lands and becomes part of what a stored date **means**. And changing a zone
currently means SSH to the NAS, editing `.env`, and a restart — for a household
where the owner deploys by hand and the alternative is a dropdown.

There was also a plain inconsistency in the evidence. The handoff records the
nightly dump confirmed at "02:30 Central", which is not the zone the build prompt
for this feature assumed. Nobody could answer "what zone is this actually set to"
from inside the application, which is its own argument.

## Decision

**`budget_settings.schedule_timezone`, nullable, chosen in Settings.**

- **Null means "use `SCHEDULE_TIMEZONE`".** The environment variable stays the
  floor rather than being migrated away: it is what the container has before it
  can reach the database, and a first boot against an empty schema still has to
  know when to run. Existing deployments therefore keep firing exactly as they do
  now, and the migration changes when nothing fires.
- **The database is not the repository.** Hard constraint 4 is about what gets
  committed. A zone in a table the owner owns, dumped nightly into his own
  backups, is not personal data in this repository — so this resolves the
  tension rather than breaching it.
- **It governs when jobs fire and nothing else.** The process clock is untouched.
  Every date the domain computes — which day a transaction posted on, which day a
  valuation is as-of, which day a Bitcoin close belongs to — stays UTC. Moving
  those is a real decision with real migration consequences and belongs on its
  own branch; it is recorded in `docs/open-questions.md` rather than smuggled in
  here.

  **Superseded by [ADR 037](037-a-day-is-the-households-day.md)**, which is that
  branch. The setting now also decides which day an instant falls in. The feared
  migration turned out not to exist: `posted_at` already holds a true instant,
  and the two `@db.Date` columns hold decided days that need no zone. Everything
  else in this ADR stands.

- **Writes are administrator-only**, like every other settings write.
- **Saving it rebuilds the schedules.** `node-cron` fixes a task's zone when the
  task is created, so a stored value that only took effect on the next restart
  would be a setting that appears to work and does not. The scheduler stops its
  tasks and starts new ones on the write.

## Consequences

- **The interface can finally answer "when does this run, in what zone".**
  Settings → Sync already names the backup schedule and the zone it believes it
  is configured with; that reading now comes from the same place the scheduler
  reads, rather than from an environment variable the page was told about.
- **One more thing that can be wrong from the UI.** A mistyped zone would move
  every job. The value is validated against the same `isKnownTimeZone` check the
  environment variable uses, and an unknown name is refused at save time rather
  than at the next fire.
- **The snapshot job's "previous day" is now the household's day.** A run at
  03:00 local labels the row for the local day that just ended, which is what
  makes the date on a chart mean what a person reading it assumes.
- **Rebuilding tasks on write is a small amount of lifecycle to get right.** The
  scheduler gains a restart path that must stop the old tasks — a leaked task
  would double every job, and a double sync is a `sync_already_running` conflict
  rather than a corruption, but a double backup is two dumps and a double
  snapshot run is wasted work on two cores.
