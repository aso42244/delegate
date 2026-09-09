# 056 — Where a person lands, and the root that is not a page

**Status:** accepted
**Date:** 2026-09-09

## Context

Overview was built to replace Insights, and the owner asked for it to join the
navigation as the first destination with Budget second — Overview for a quick
review, Budget for operations and a full inspection. He also asked for the
landing page to be a per-person setting: two people read this budget for
different reasons, and one household setting would make one of them wrong every
day.

The obstacle was that **`/` was the Budget page's own address.** A landing
preference against that root can only redirect _away_ from something that is
already a page, which is a redirect that fires on every visit for one of the two
people and never for the other — and leaves Budget with no address of its own to
be linked to.

## Decision

**The root is a redirect, not a page.** `/` resolves to whichever page this
person lands on. Budget moves to `/budget`.

**The preference is a column on the person, not a device setting.** Where you
land is a fact about you, not about the browser you happen to be sitting at. It
sits beside the display name on Settings → Users and is written through the same
`PATCH /api/auth/me`, for the reason that route already gives: what you are
called is yours to set whatever role you hold, and there is no privilege to
protect. **An Admin cannot set it for somebody else**, which is the point.

**Both fields on that route are optional and each is applied only when sent.** A
client that had to send the other back unchanged is how a display name gets
cleared by a page that never showed it.

**Two values, Overview and Budget.** A landing page answers a whole question and
those are the two that do. Landing somebody on Rules is a setting nobody wants
and one more thing to keep working.

**Null means "never chose", and the default is applied by the reader.** The
column stores no default. That is what lets the default move later without
silently overriding a decision somebody made — and it is why the API returns
null rather than helpfully substituting `overview`.

**Insights is deleted.** `/insights` redirects to `/overview`, the same promise
`/bills` and `/utilities` make: the thing a bookmark pointed at still exists, in
better form. The page, its routes, and the tests that drove them go together.

**`insight_layouts` stays in the database.** Nothing reads it. Dropping it would
destroy an arrangement somebody made, and keeping a table costs nothing — the
same reasoning as `archived_at` everywhere else.

## Consequences

- **93 end-to-end call sites moved from `/` to `/budget`**, and the `signedIn`
  fixture now names its destination. Every one of those specs was relying on the
  coincidence that the root happened to be the budget; saying so is an
  improvement independent of this change.
- **The session's `currentUser` had to select the new column.** It did not at
  first, so the preference saved correctly, read back as null on every request,
  and the root redirected to the default however anybody chose. It was caught by
  the end-to-end test rather than by anything nearer the defect — a reminder
  that a field added to a model is a field every narrow `select` has to be
  checked against, which is the same shape as the `region` defect in v0.61.0.
- **The sidebar is six entries**, from eight: Overview, Budget, Transactions,
  Rules, Recurring, Settings. The tab bar's columns still come from the page
  list rather than a number beside it.
- Overview uses the `insights` icon. It inherited the page it replaced rather
  than inventing a glyph.
