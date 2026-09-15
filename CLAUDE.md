# Delegate

A self-hosted envelope budgeting application for one household, running on a
Synology NAS.

## Read these first, in this order

1. **`docs/handoff.md`** — authoritative. Your authority, the six hard
   constraints, how deployment works, the environment's quirks, and the lessons
   that each cost real time. Read it fully before doing anything.
2. **`docs/ui-system.md`** — the measurements every screen uses. **Read before
   any interface change**, including a one-line one. This is the file that stops
   the interface drifting back into seventeen dialects.
3. **`docs/design.md`** — the visual language: colour, the chip vocabulary, tone,
   and the record of settled design decisions. Read before UI work; read it as
   written rather than re-deriving it.
4. **`docs/architecture.md`** — only if you touch the domain, the ledger, or
   money.
5. **`docs/decisions/*.md`** — only the ones your task actually touches.

Where `design.md` and `ui-system.md` meet: the first says _why_, the second says
_how much_.

## Non-negotiable

These are in `docs/handoff.md` in full. The short version, because each one is a
build failure rather than a preference:

- **`npm run verify` is the gate.** There is no CI. It is the only thing between
  a branch and `main`, and nothing but you enforces that it passed. It sources
  `.env` itself, so it runs from any shell. Never pipe it — redirect and check
  `$?`, or you are reading `tail`'s exit status.
- **All money is integer cents in `BIGINT`.** Never a float, never a JavaScript
  `number` in arithmetic or persistence. Decimal strings over HTTP.
- **Nothing is ever hard-deleted.** `archived_at` everywhere; archived rows stay
  resolvable.
- **No personal data or secrets in this repository.** `.env` is git-ignored.
- **The UI system is enforced by a test.** `apps/web/src/components/ui-system.test.ts`
  reads the source and fails the gate on an off-scale spacing value, a
  hand-rolled page header, an undeclared field width, a bare `<details>`, or a
  create button named anything but `New <noun>`. If a rule genuinely does not
  fit, change the spec and the test deliberately — do not work around them.
- **The asset class term is banned; the asset is Bitcoin.** CI enforces it.
  Narrowed by ADR 010: `node:crypto` and cryptography generally are fine.
- **USD only.**

## Workflow

Branch → work → `npm run verify` passes → PR → squash merge → a separate
`chore: cut vX.Y.Z` PR moving the CHANGELOG entry from `[Unreleased]` to a
version heading → tag → wait for the publish workflow to go green → confirm the
registry returns the manifest → hand over the deploy line.

**The owner deploys, not you.** SSH to the NAS is password-auth and you do not
have it. He types **exactly one line**, never two:

```
cd /volume1/docker/delegate && sudo ./scripts/deploy.sh --tag vX.Y.Z
```

Give it in its own fenced `bash` block with nothing for him to run before or
after it, and not until the image is confirmed pullable — a tag is not a release.
Then assume it is deployed. `docs/handoff.md` § **Releasing and deploying** has
the whole of it.

## Running in the cloud

The docs travel with the clone; `.env`, `node_modules`, the Postgres databases
and the NAS do not. **Everything needed to run the gate does.** This image ships
Postgres and Docker installed and stopped, which `psql -l` and `docker info`
report exactly as if they were absent — so check `which dockerd` and
`service postgresql status`, not the daemons. Start them, install the pinned
chromium, and `npm run verify` runs unmodified, every step. `docs/handoff.md`
§ **If you are running in the cloud** has the two minutes of setup.

So a cloud session is under the same rule as a local one: the gate must actually
pass before a merge, and merging never needs permission. Never imply it passed
when it did not, and never read an exit code through a pipe — not `| tail`, and
not a command that ends in `| grep`.

## Knowing where things stand

Never assert a version from a document. `git log --oneline -10` — the newest
`chore: cut vX.Y.Z` is the current release; `[Unreleased]` in `CHANGELOG.md` is
what is merged and not yet cut. `docs/handoff.md` § **How to know where things
stand** has the rest.

Conventional Commits. Commit messages end with the co-author trailer, PR bodies
with the Claude Code footer.

## Before believing a strange failure

Check the machine, not the branch. `uptime`, and
`ps aux | grep 'apps/api/dist/server.js'` — an interrupted run leaves a server
against the **test** database that answers `/health` perfectly well and makes the
next run look broken. Scattered end-to-end timeouts in specs you did not touch
are an environment signal. `docs/handoff.md` has the rest.
