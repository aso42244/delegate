# 058 — The demo is a second instance, not a mode

**Status:** accepted
**Date:** 2026-09-09

## Context

The owner wants to show Delegate to people without showing them his household's
money. A demo, at `/demo`, with enough history to look real and always current
as of the day it is shown.

The obvious implementation is a demo _mode_ inside the running application:
a flag, a second set of rows, a switch on every read. It is also the wrong one.
**Delegate is single-household by design** — there is no tenant column anywhere
and every query is household-wide — so a demo mode means adding tenancy to every
table and every read, and the failure mode of getting one query wrong is a real
balance on a page shown to a room.

## Decision

**A second container, its own database, the same image.** Nothing to get wrong
per query, because there is no query that could reach the wrong data: they are
different processes against different databases. Cheaper than tenancy, and it
cannot decay into being wrong later.

**Read-only is a wall, not a mode.** `DELEGATE_DEMO` refuses every write before
it reaches a route. **The method is the test rather than a list of endpoints** —
a list of writes is a list somebody has to remember to add to, and the one nobody
adds is the one that matters. Signing out is the single exception: it destroys
only the visitor's own session, and without it nobody can leave.

The interface hides what it cannot do, because a control that answers 403 reads
as a broken application. **The interface is never what enforces it.**

**Only signed-in members of the household can reach it.** Caddy asks the real
application before forwarding, through `/api/auth/gate` — a purpose-built
endpoint behind the _full_ authenticated chain. `/api/auth/me` was the obvious
thing to point at and carries only `requireSession`, so a session that has not
finished enrolling a second factor passes it; a gate meaning something weaker
than the rest of the application is one that will be wrong exactly once.

**The demo signs its visitor in without a session.** There is no account to
protect and nothing to change, so asking for credentials to a fictional household
would be asking for nothing. No session row is written either, which keeps a
read a read.

**Caddy strips the prefix**, so the container is an ordinary Delegate at its own
root. Only the _build_ knows about `/demo`, through `VITE_BASE_PATH` — one value,
read in one place, used by the router, the assets and every request. A
disagreement between any two of those shows up as a blank page rather than an
error, which is why it is not three settings.

**A distinct cookie name.** Both instances answer on one domain, and two cookies
called `budget_session` are two cookies the browser sends together — the one
arriving first belonging to the wrong instance and signed with a secret it cannot
verify.

## The data

**Built through the domain's own functions, then backdated.** `runDelegate`,
`createManualTransaction` and `categorizeTransaction` stamp _now_, which is the
one thing they cannot be asked not to do; so the state is built correctly and
every row is given its real date in one pass afterwards. Backdating cannot
disturb a balance — every balance is a sum over events, and a sum does not care
when its terms were written.

**The delegations are derived from the charges, not chosen.** Sixteen hand-picked
amounts produced a household whose every line climbed for eighteen months,
because each guess was comfortably over what that line actually spent. A budget
where nothing is ever tight is a budget with nothing to show.

**The nightly snapshots are reconstructed, not invented.** One is written at the
start of the window and `fillGaps` rebuilds the rest from the ledger — the same
code that repairs a real household's missed nights, so the demo exercises that
path rather than side-stepping it. `MAX_GAP_DAYS` caps a pass at 370, so
eighteen months is two passes.

**It opens with money waiting to be delegated.** The newest pay packet is left
undistributed on purpose: Delegate is the action this application is named for,
and a demo that opens with the button greyed out has to be explained rather than
shown.

## Consequences

- **The demo is rebuilt, not migrated.** The seed wipes and regenerates, and it
  refuses to run unless `DELEGATE_DEMO` is `true` — pointed at a household's real
  database it would destroy the thing this application exists to protect.
- **Nothing in the demo can be arranged**, including the Overview layout, so the
  arrangement it opens with is seeded rather than left to the default.
- **`/demo` is unlisted, not private.** Anybody signed in to the household can
  reach it. That is the stated intent; it is written down here so it stays a
  decision rather than becoming an assumption.
- A demo that is never deployed costs one profile in `docker-compose.yml`.
