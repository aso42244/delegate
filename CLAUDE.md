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
  a branch and `main`, and nothing but you enforces that it passed.
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
version heading → tag → `git archive` a tarball.

**The owner deploys, not you.** SSH to the NAS is password-auth. Hand him the
two commands.

Conventional Commits. Commit messages end with the co-author trailer, PR bodies
with the Claude Code footer.

## Before believing a strange failure

Check the machine, not the branch. `uptime`, and
`ps aux | grep 'apps/api/dist/server.js'` — an interrupted run leaves a server
against the **test** database that answers `/health` perfectly well and makes the
next run look broken. Scattered end-to-end timeouts in specs you did not touch
are an environment signal. `docs/handoff.md` has the rest.
