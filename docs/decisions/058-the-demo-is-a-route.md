# 058 — The demo is a route, not a deployment

**Status:** accepted
**Date:** 2026-09-09

## Context

The owner wants to show Delegate to people without showing them his household's
money: a demo with enough history to look real, always current as of the day it
is shown, and reachable only by somebody already signed in.

**The first version of this was a second instance** — its own container, its own
database, its own migrations and seed, a Caddy `forward_auth` gate, base-path
support through the build, and four environment variables. That is a sound design
for a demo _the public can reach_, where the only way to be certain a visitor
cannot read a real balance is for the demo to be a different process against a
different database.

It is the wrong design for this one, and the owner said so plainly: he wanted a
page, and was handed a deployment.

## Decision

**The demo is a route in the application that already exists.** `/demo/overview`
is the same page as `/overview` — the same components, the same queries, the same
session — drawing invented numbers.

**It is gated by being a page.** There is no separate authentication to build,
because reaching any page means being signed in already. The requirement that
made the second instance necessary — _anybody on the internet may reach this_ —
was never the requirement.

**The whole application makes exactly one `fetch`.** That is the only place that
knows about the demo: on a demo page it answers from a fixture computed in the
browser, and a write throws rather than pretending. Everything else — every
component, every query, every chart — is untouched and cannot tell the
difference.

**The numbers are computed, not stored.** Every date counts backwards from today
on each render, so a demo shown in March and one shown in July are both current.
There is nothing to seed, nothing to migrate, nothing to keep running and nothing
to reset.

**The navigation stays inside the demo**, and only pages with invented data are
offered. A link to a page whose figures are not invented is a link to an empty
screen, which reads as a fault rather than a boundary.

## What the data does

**The delegations are derived from the charges, not chosen.** Sixteen hand-picked
amounts produced a household whose every line climbed for eighteen months,
because each guess was comfortably over what that line actually spent. A budget
where nothing is ever tight is a budget with nothing to show.

**Each line opens with two cycles in hand.** Without it the arithmetic very
nearly cancels — eighteen months of funding against eighteen months of spending —
so ordinary week-to-week noise put most lines in the red at once, and a page
where everything is over-spent reads as a broken budget rather than a working
one.

**It opens with money waiting to be delegated.** The newest pay packet is left
undistributed: Delegate is the action this application is named for, and a demo
that opens with the button greyed out has to be explained rather than shown.

## Consequences

- **Nothing to deploy and nothing to operate.** The demo ships with the
  application and costs a route.
- **The demo covers Overview and Budget.** Adding a page means writing the
  fixture for what it reads; the navigation offers only what has one.
- **`/demo` is reachable by anybody signed in**, which is both people in this
  household. That is the stated intent, written down so it stays a decision.
- **What the second instance was right about is recorded here and abandoned
  deliberately:** if this demo ever needs to be public, a route in the real
  application is not the way to do it, and this ADR should be superseded rather
  than stretched.
