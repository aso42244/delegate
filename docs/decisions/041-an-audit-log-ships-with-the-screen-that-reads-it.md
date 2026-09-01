# 041. An audit log ships with the screen that reads it

**Status:** accepted
**Date:** 2026-09-01

## Context

An `auth_events` table has been asked for by three external security reviews:
twice in August 2026 and again in September. It was declined twice, and the
reason is worth stating properly rather than being quietly reversed now that it
is being built.

The objection was never that the events are uninteresting. It was that **a table
nobody queries is worse than no table at all**, because it looks like a control
while nothing reads it — and this project has already paid for exactly that
mistake. The nightly `pg_dump` failed every night for months. It was recorded
correctly, at error level, into a log nothing read. The comment at the top of
`backup.sh` said "a thing that fails quietly is worse than one that does not run
at all, because it is trusted" while the thing it described was failing quietly.
The lesson written down afterwards was: **check for the evidence a thing leaves,
not for the absence of an error.**

An audit table with no screen is that shape again. It would satisfy a review, sit
in the schema, grow, appear in every dump, and answer nothing — because nobody
runs `psql` against their own budget on a Tuesday to see whether anything odd
happened.

The owner asked for it to be built, and asked for the screen with it.

## Decision

**The screen is the feature. The table is how it is fed.**

Settings → Users carries a third card, **Sign-in activity**, which shows the most
recent events without being asked — the same posture as the backup card, which
answers "is there a recent dump on disk" rather than "did the last attempt
throw". If that card is ever removed, the table should go with it.

Four decisions inside that:

**Credentials only.** Sign-in, sign-out, refused password, refused code, password
changed or reset, two-factor enrolled, disabled or reset, and account created,
archived or restored. **Not reads.** Everyone in this household sees the whole
budget by design, so opening a page is not an event; a row per page view would
bury the dozen lines a year that matter under tens of thousands that do not.

**A name is stored only when it is a name.** The login form has two fields, and a
password typed into the top one is common. `describeAttemptedUsername` stores the
username when it matches a real account — which a mistyped password cannot — and
a short keyed digest (`unknown:xxxxxxxx`) otherwise. Repeated attempts against
one unknown name still line up as one line of enquiry; what was typed is never
written down. The digest is keyed so a stolen dump plus a dictionary cannot turn
the column back into a wordlist.

**Subject and actor are separate columns.** Every administrator action here is
done _to_ somebody, so a record that conflated the two could not answer the only
question worth asking about one: who reset that password.

**It is pruned, and it is the only table here that is.** Ninety days, matching the
absolute session lifetime, swept at sign-in beside the expired sessions.

That last one bends the "nothing is ever hard-deleted" constraint, deliberately
and narrowly. That rule is about the household's **data** — accounts,
transactions, delegations — where an archived row stays resolvable so an
eight-month-old transaction still renders `Grocery (archived)`. This is an
operational log, and it is the one table in the schema an **unauthenticated**
stranger can cause writes to: every refused sign-in is a row. The rate limit caps
that at ten per five minutes per address, which is slow enough not to matter and
fast enough to be unbounded over a year. An audit log that can be grown without
limit by the person it exists to catch is not an audit log.

## Consequences

**A failed sign-in now costs a write.** One insert on a path that was previously
read-only, behind a rate limit that already bounds it. On two cores this is
nothing; it is named because it is the only new cost.

**Recording never fails the request it is recording.** `recordAuthEvent` catches
and logs rather than throwing. A sign-out that returned 500 because its audit row
could not be written would leave somebody pressing it again on a session that is
already gone, and a credential change that succeeded is not undone by a missing
record. This is the one place a log line is the right answer, because the thing
it reports is the recorder itself being broken.

**The card is administrator-only**, like the household table above it, and
`GET /api/auth-events` answers 403 rather than an empty list to anyone else — an
empty answer would read as "nothing has happened".

**Fifty lines, no filter, no pager.** The question somebody arrives with is "has
anything strange happened", and its answer is always on the first page. An older
question than that is a `psql` question, and a control nobody presses is worse
than no control.

**The address is recorded and is sometimes a fiction.** `request.ip` honours
`TRUST_PROXY`, so behind the Cloudflare Tunnel it is the visitor; over the onion
service it is the loopback address of the SOCKS hop and means nothing at all. It
is stored as text rather than `INET` for that reason — a column typed as an
address invites arithmetic on a value that is sometimes not one — and it is the
first column dropped on a narrow screen.
