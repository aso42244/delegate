# 057 — One way to make a thing

**Status:** accepted
**Date:** 2026-09-09

## Context

There were seven create buttons over five screens: New transaction and New check
on Budget, New transaction again on the register, New grouping in two places, New
rule under Settings → Rules, New property under Settings → Properties. A phone
folded four of them behind a `⋯` sheet that existed only below a breakpoint.

ADR-era work had already named them consistently — the audit found Add, Create,
New and "Set up" all in use, and both "Add grouping" and "New grouping" for the
same action. Naming them all `New <noun>` fixed the words. It did not fix that
there were seven of them, each wherever its own page happened to have room.

The cost is not the pixels. It is that **the page you are on is part of the
question**: making a delegation means knowing delegations are made on Budget, and
recording a cheque means being on the right screen first.

## Decision

**One control, `New …`, rendered by `PageHeader` on every page.** Six items
behind it: transaction, transfer, check, delegation, grouping, rule.

**The header renders it, not the pages.** "On every page" is a promise no page
can keep on its own — the seven buttons it replaces were each in whichever corner
their own screen had room for.

**It is the leftmost action**, so it holds the same position whatever else a page
puts beside it.

**The dialogs did not move.** Each still lives with the screen that owns the
thing it makes, and the menu imports them. A second implementation is how two
routes to one action come to disagree, which is exactly what "Add grouping" and
"New grouping" on two screens already were.

**What a page keeps is anything that is not creating a thing.** Delegate,
Arrange, Run rules, and every row-level action belong to the page they act on.
Delegate in particular is not a create button: it is the act Budget exists for.

**The queries behind the menu run when something is being made**, not on every
page load. This control is in every header, and three requests behind a closed
menu on every screen is a real cost for a thing pressed a few times a day.

**A delegation is a name and nothing else.** The amount, the grouping and the
order are set on Budget where the line can be seen against the others; asking for
them here would be four fields for a thing whose only required one is what to
call it.

**The phone's `⋯` sheet is gone** with the buttons it folded away. One control in
one place beats a control that only exists below a breakpoint.

## Consequences

- **`ui-system.test.ts` gained a rule and kept one.** `New <noun>` on a page is
  now a second route to something the header already offers, and the test fails
  on one. The older rule — that a submit button inside a create flow is the bare
  verb — is unchanged.
- **The inline "grouping name, then Enter" input on Budget is gone.** It was a
  third way to make a grouping, and a different one: no dialog, no section
  choice, Escape to cancel. It is the same dialog Settings uses now.
- **Every end-to-end spec that created something goes through the menu**, which
  makes each of them a test that the menu reaches that dialog.
- New property stays on Settings → Properties. A property is not one of the six:
  it is a rarely-created thing that belongs to the page explaining what it is
  for, and putting it in a menu on every screen would say otherwise.
