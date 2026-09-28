# 071 — Tokens are managed on Access, as a card

**Status:** accepted
**Date:** 2026-09-21

Where the credential of [ADR 069](069-a-token-reads-as-a-person.md) is made,
read about and revoked. Follows [ADR 033](033-one-ui-system-with-a-test-that-holds-it.md)
and [ADR 061](061-every-page-is-a-page-of-tiles.md), and the Settings grouping
recorded in `design.md` ("Settings, and the width the shell was taking").

## Context

The brief asked for a tab. Settings had twelve of those in v0.45 and half of them
held a single card, which is why v0.46 cut them to eight grouped by the question
somebody came to answer — and why `ui-system.md` §11 says so in its first line.
A ninth section holding one table would be the drift that change was made to
stop, on the day the change was made.

The question a person arrives with is "who gets in and how". That is
**Access**: your account, your second factor, the onion service, the household,
and what has happened to credentials. A token is your credential, issued for a
machine.

## Decision

**A card on Settings → Access — `ApiTokensCard` in `pages/settings/ApiTokens.tsx`
— beside two-factor and the household, not a section of its own.** Half a row,
between the three thirds about getting in and the two halves about who has been.

**Two things the card exists to show: when each token was last used, and from
where.** That visibility is half of why the credential shape is safe at all — a
machine nobody is running any more is obvious on this card before anybody has to
wonder about it — so the two columns are the table, not an afterthought behind a
disclosure.

**The secret is shown once, in the dialog that made it**, with the sentence that
says so and a Copy button that reports what actually happened (the LAN address
is plain http, where `navigator.clipboard` does not exist). The dialog is not
`dismissible`: a stray click beside the card would lose the only copy.

**Revoke is on the row menu**, red, as Archive is everywhere else. A revoked row
stays in the table, greyed and marked, because it still answers the question the
card is for. Live tokens first, newest first; revoked after.

**`New token` in the card header**, as `New person` is on the household card
beside it. ADR 057's "one way to make a thing" put the six domain nouns behind
the page-header menu; a settings card that lists a kind of thing and creates it
keeps its create button in its own header, which is what every card on this tab
already does.

**Columns give way by the card's width, not the window's** — `@sm:` and `@md:`
— per `ui-system.md` §6. The name and the status stay at every width; last-used
and from appear as the card has room.

**The mockup came first**, as a clickable page in Delegate's own tokens, and the
card is built to it.

## Consequences

- `SettingsIndex` and `SettingsLayout` are untouched: Access already exists and
  the phone's index already lists it. The e2e test that counts seven sections
  still counts seven.
- Everyone sees the card, at every role. A token is yours; there is nothing here
  for an administrator to do to somebody else's, by ADR 069's rule that a token
  that is not yours does not exist.
- Issuing and revoking appear on the Sign-in activity card two rows down, as
  `API token issued` and `API token revoked`, because they are credential
  changes and that card is the record of those.
