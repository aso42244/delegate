# 030. A program authenticates with a scoped token

**Status:** accepted
**Date:** 2026-08-19

## Context

The owner wants Claude and Notion AI to reach the budget through the Model
Context Protocol. Whatever else that needs, it needs an authenticated caller
that is not a browser.

Everything that authenticates here today is a person: a password, a session
cookie with `SameSite=Lax`, a code from an authenticator, an origin check that
assumes a browser sent the request. A program has none of that. It holds one
string, sends it on every call, and cannot be prompted for anything.

The obvious answer — issue an API key, accept it as a bearer token — is fine as
far as it goes and stops well short of the actual problem. The program at the
other end is a language model acting on text somebody typed. A request is
**input, not an instruction**, which is the same reasoning that took Phase 5 off
the roadmap; the difference here is that the input arrives at a credential
rather than at a pull request.

## Decision

Three things, and the third is the one that matters.

### A token is a selector and a secret

`dlg_<16 hex>_<43 char base64url>`. The selector is stored in the clear under a
unique index; only the secret half is hashed. Verification is one indexed lookup
and one digest comparison.

The alternative — hash the whole token with a salt, as passwords are hashed — is
not available: a salted hash cannot be looked up, so verifying means hashing the
presented value against every stored row, and the cost of a request grows with
the number of tokens ever issued.

### The hash is SHA-256, not argon2id

Passwords and recovery codes are argon2id at 19 MiB (ADR 007). This is not, and
the departure is deliberate.

Argon2's memory hardness exists to make **guessing** expensive, because a human
chose the secret and the space of things humans choose is small. Nothing here was
chosen by a human. The secret is 256 bits from `randomBytes`; there is no
dictionary, no rule, and no amount of hardware that makes guessing it a strategy.
Memory-hard hashing buys nothing against an attacker who cannot guess.

What it costs is real: 19 MiB and a couple of passes per verification, on a
Celeron J4025, on every single call an MCP tool makes. That turns a chatty
read-only client into a load problem for no security gain.

### Scope is an allowlist of route patterns, not a rule about methods

`read` and `read_write` are both allowlists of `METHOD /pattern`, matched against
`request.routeOptions.url` — the pattern Fastify registered, not the path the
caller sent. There is no string to normalise and no traversal to defend against,
and a request that matched no route has no pattern, so it is refused.

"Read scope means every GET" sounds equivalent and is not. `GET /api/settings`
carries the onion address; `GET /api/users` is the household. Both are correct
for a browser and neither belongs in a chat transcript held by a third party.

The write list is bounded by **reversibility by somebody who did not expect the
change**. Categorizing a transaction and editing the rules that categorize
automatically are on it. Deliberately absent:

- Anything that moves money. Delegate runs, transfers, manual adjustments and
  reconciliation write to the event ledger, and undoing one is a ledger
  operation rather than an edit.
- Anything that archives, which is this application's destructive operation.
- `POST /api/rules/apply`. Writing a rule is inert; applying one rewrites
  categorizations across the whole history, including ones made by hand. Those
  are different sizes of mistake and they get different answers.
- Settings, users, sync, Bitcoin and the token routes themselves. A token cannot
  turn off two-factor, cannot open remote access, and cannot mint another token
  or revoke the one being used to hunt for it.

## Consequences

A token bypasses the second factor by construction, because there is nothing to
present a prompt to. It is issued from a session that has already cleared one,
by an administrator, and it dies with the account that made it — `requireSession`
and the token path read the same live row, so archiving an account takes its
tokens out immediately.

Adding a route to either list is a decision about what may leave the house, made
in one file, and a test asserts every entry still names a route that exists — a
rename would otherwise fail closed and silently, which is safe and invisible.

Revocation is permanent. Everything else in this schema is archived so it can
come back; the only thing "un-revoke" could do is undo a decision that was made
because something had leaked.

The MCP server is the first consumer and the reason this exists, but nothing
above is specific to it. A shell script with `curl` has the same reach, which is
the right amount: the boundary belongs to the credential, not to the client that
happens to hold it.
