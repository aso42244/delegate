# 069 — A token reads as a person

**Status:** accepted
**Date:** 2026-09-21

Delegate's first machine credential since the Model Context Protocol work was
withdrawn in v0.17.0 and its `api_tokens` table dropped. Implements the
credential half of Eventide's ADR 268, which settled that Delegate stays its own
application and Eventide reads it through a narrow door. Companion to
[ADR 070](070-the-read-door-is-its-own-surface.md) (the door) and
[ADR 071](071-tokens-are-managed-on-access.md) (where it is managed).

## Context

Delegate authenticates with a session cookie and a mandatory second factor, and
nothing else. That is right for a browser and impossible for a program: a
program has no cookie jar, cannot answer a TOTP prompt, and has no screen to be
shown a sign-in page on. Eventide's Finances view has been blocked on exactly
this — there was nothing for it to knock with.

Eventide has built this credential twice, and the second time is the closer
model. Its agent token (ADR 029) is hashed at rest, revocable on its own,
visible, and narrow — and deliberately **never becomes a person**. Its voice key
(ADR 285) is the same shape with the opposite property: it has to speak as one
person, because "what's on Saturday?" is answered from _that person's_ calendar.
ADR 285 exists because those two could not share a table.

A read of this budget is the second kind. Whatever the Finances view shows, it
shows with the access of whoever issued the token — which in a household where
everybody sees the whole budget is the whole budget, and which is still a
privacy question rather than a plumbing one.

## Decision

**A bearer token, stored as a digest, that authenticates as the person who made
it.** Table `api_tokens`; module `domain/api-tokens.ts`; prefix `dlg_`.

**`user_id` is `NOT NULL`.** One table holding tokens that may or may not carry a
person would mean every lookup returning a row where a null check is the only
thing between a stranger and the budget. A type that cannot express the unsafe
case is worth more than a check that remembers to.

**You may only make one for yourself.** `issueApiToken` takes one person and
there is no field on the route that could name another. A token that speaks as
somebody else is that person's budget handed over in a text box.

**It is listed and revoked by its owner, scoped in the query.** Somebody else's
token answers 404, which is what a token that does not exist answers. An id is
guessable in a way a digest is not, and revoking a household member's machine is
a denial of service on them.

**It reaches the read door and nothing else** (ADR 070). There is no scope
column because there is nothing to choose between; the table that stood here
before carried `read` and `read_write`, and the second value is the reason it
was a worse design.

**A fast digest, not a password hash.** SHA-256, looked up by digest in one
indexed seek, then compared in constant time. argon2id exists to make a
_guessable_ secret expensive to guess; 256 bits of randomness cannot be guessed,
and this is checked on every request. The arithmetic — generate, digest, compare
— is the top of the module, because those three are what a second copy of a
credential always gets wrong.

**Shown once.** The secret exists in the clear in exactly one response, the one
that created it. The nightly dump contains this table, and a dump that hands
over a working credential is the reason passwords are hashed too.

**Revoking is a timestamp.** Nothing is hard-deleted here, and a revoked row is
exactly the record somebody wants when asking which machine had this and when it
last read the budget.

**An archived account's token stops at once**, for the reason its sessions do:
one rule about what a live account is, not two. A password reset does _not_
revoke tokens — that is the property that makes revocation independent in both
directions, and the tokens are on the same screen as the password.

**Issuing and revoking are credential events** in the log ADR 041 built, so the
Sign-in activity card reports them without being asked.

## Consequences

- Eventide's 8b-ii is blocked on nothing here. The credential and the door ship
  together, and the contract is `docs/api-for-eventide.md`.
- Two things a person might reasonably expect and will not find: a token does
  not expire on its own, and it is not scoped narrower than "the read door".
  Both were left out on purpose. An expiry is a way to be locked out on a
  Saturday for no reason anyone remembers; the card shows when each token was
  last used, which is the information an expiry would be a blunt substitute for.
  A narrower scope has nothing to narrow to while the door is two reads.
- `api_tokens` is the name of a table this schema has had before. The drop
  migration from August still stands — migrations are forward-only (ADR 003) —
  and this one recreates the name with a different shape. The handoff's note
  that the drop was "the only trace left" of the MCP work is now history rather
  than status.
- Centralized sign-on is not opened by this. Two applications and two people do
  not need it; Eventide's Q1148 holds it until a third application exists.
