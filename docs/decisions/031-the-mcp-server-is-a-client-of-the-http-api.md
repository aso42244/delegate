# 031. The MCP server is a client of the HTTP API

**Status:** accepted
**Date:** 2026-08-19

## Context

The owner wants to ask Claude about the budget in the same conversation where he
is doing something else, and to have it sort a backlog of transactions without
opening the Transactions page.

The Model Context Protocol is how an assistant calls someone else's software. A
server advertises typed tools; the client decides which to call and gets
structured results back. It is a plugin standard, and it says nothing at all
about who is allowed to do what — that part is ours (ADR 030).

## Decision

A fourth workspace, `apps/mcp`, is a **separate process that talks to Delegate
over its own HTTP API with an API token**. It opens no database connection and
imports nothing from `apps/api`.

### Over stdio, and not over the internet

The client starts the process and talks to it over a pipe. Nothing listens on a
port, nothing is added to the Cloudflare Tunnel, and the onion service is
untouched. Delegate's exposure is exactly what it was yesterday.

The alternative — Streamable HTTP at `/mcp`, reachable by claude.ai and by
Notion — is a real and wanted capability, and it is deliberately not this
change. It needs Delegate to become an OAuth 2.1 authorization server, and it
means the household's finances crossing into a third party's infrastructure on
every tool call. Both deserve their own decision rather than arriving as a
consequence of this one.

### Through the API, not through Prisma

The tempting shortcut is to import the domain layer and query the database
directly: fewer hops, no token, no HTTP. It is the wrong boundary.

Going through the API means the domain rules, the cents-as-decimal-strings
contract (ADR 002), archived rows staying resolvable, the ledger being written
in one transaction, and the token allowlist are all enforced on the far side.
A tool that gets something wrong gets a 4xx. A tool with a Prisma client that
gets something wrong writes a wrong budget.

It also means the MCP server can never do more than a person could do through
the interface, which is the property that makes the whole thing safe to hand to
a language model.

### Amounts are formatted dollars, and results are text

Cents stay exact all the way to the display edge, exactly as they do in the web
client, and then become `-$4,210.00`. A model handed `-421000` will sometimes
decide it is four hundred thousand dollars.

Results are aligned plain-text tables rather than JSON. Every token a tool
returns is one the conversation cannot spend on the question that prompted it,
and a JSON array of a hundred transactions is mostly punctuation and repeated
keys.

### Envelopes are named, not identified

A model holds the conversation's vocabulary — "groceries", "the car fund" —
and never a UUID unless something put one in front of it. So names are accepted
anywhere an id is.

The resolution rules are strict about ambiguity on purpose: an exact match wins
outright, and anything else must be unique or it is refused with the candidates
listed. A budget containing both "Car" and "Car insurance" must still be able to
say "Car" — and must never have a tool pick between them, because the wrong pick
moves real money and does it silently.

### The write tools exist only when the token allows them

The server asks `GET /api/app` at startup, which reports the presented token's
scope, and registers the write tools only for `read_write`. The server would
refuse them anyway; this is about not offering a model a button that cannot
work, and about failing at startup — where the operator is looking — rather than
mid-conversation.

The same answer is repeated in the server's instructions, in prose, so a model
that cannot move money says so and offers to walk the owner through it instead
of trying, being refused, and reporting what reads as a broken connection.

## Consequences

`npm run verify` grows a step that spawns the built entrypoint and speaks the
protocol to it. Importing a module would not have caught the two things that
have actually gone wrong here: a stray write to stdout corrupts the stream and
the client simply never starts, and the first version of the write tools assumed
the categorize endpoint echoes the transaction back when it returns a count —
so the write landed and the tool reported failure, whose natural next move is to
do it again.

The container image does not carry any of this. `npm ci` reads every workspace
the lockfile names, so the manifest is copied in and the production install is
scoped to the workspaces that actually run on the NAS.

Anything the tools cannot reach is reachable from the interface, and the tools
say so rather than pretending. `create_rule` states that a new rule is inert
until applied and that applying one is done from Settings → Rules, because
applying it across history overwrites categorizations made by hand.
