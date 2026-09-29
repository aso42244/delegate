# Open questions

Questions that are genuinely open: raised by the work, deliberately not answered
by it, and the maintainer's to decide. An answered question becomes an ADR in
`docs/decisions/` and leaves this file.

---

## The product

- **Does the Budget page come back to the sidebar?** It was hidden for a trial by
  [ADR 067](decisions/067-the-budget-page-is-hidden-for-a-trial.md), with Overview
  given what it needed to stand in, and a review date of 2026-09-29. The page and
  its route still exist.
- **Do the six sub-AA colour pairs in the Light palette stay?** `design.md` §2 is a
  settled specification and `theme-contrast.test.ts` records the six pairs at
  their current values, so they cannot get worse without the gate failing. Whether
  to tighten them is a design call rather than a session's.

## Running it

- **Should `main` get a protection rule?** The repository is public, so one is
  available and free. Until then "never commit to `main`" is a convention, and it
  has been broken once.
- **Should `BACKUP_CRON` move out of 02:00–02:59?** It defaults to
  `30 2 * * *`, an hour that does not exist on the spring-forward morning, so in a
  zone with daylight saving the nightly dump can be skipped one night a year. The
  snapshot job already sits at 03:10 for this reason.
- **Should the snapshot be taken before the nightly dump?** It currently lands
  after, so a restore from that night's dump is missing the most recent day.
  Harmless — the gap-filler rebuilds it — but the dump is never quite the whole
  picture the application had shown.
