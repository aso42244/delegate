# Connecting an AI assistant

Delegate can be connected to Claude so you can ask about the budget in an
ordinary conversation — "how much is left in groceries?", "what did we spend on
the car this month?" — and, if you allow it, have it sort transactions into
envelopes for you.

This page is the setup. What it can and cannot do, and why, is in
[ADR 030](decisions/030-a-program-authenticates-with-a-scoped-token.md) and
[ADR 031](decisions/031-the-mcp-server-is-a-client-of-the-http-api.md).

---

## What this is

MCP — Model Context Protocol — is a standard way for an AI assistant to call
functions in other software. Delegate provides the functions; Claude calls them.

The important part of how it is set up here: **the connector runs on your own
computer**, started by Claude, and talks to Delegate over your home network. It
is not something on the internet. Delegate is exposed exactly as much as it was
before you set this up, which is to say through the Cloudflare Tunnel and
nothing else.

What does leave your house is the _answers_. If you ask Claude what you spent on
groceries, the figures go into that conversation. That is the trade, and it is
worth being deliberate about it.

---

## What it can do

Always:

- Read the budget — every envelope, its balance, and what it is topped up to
- List accounts and debts with their balances
- Search and list transactions, including the queue waiting to be categorized
- Report spending over a period, by envelope and by grouping
- Show the full history of one envelope — every payday, every purchase
- List the categorization rules, and report the bank sync status

Only if you switch **Allow changes** on when you create the connection:

- Sort a transaction into an envelope, including splitting one across several
- Sort many transactions into one envelope at once
- Take a transaction back out of its envelope
- Write a new categorization rule

## What it can never do

Whichever way that switch is set, and regardless of what anyone asks it to:

- Move money — no payday run, no transfer between envelopes, no manual
  adjustment, no reconciling
- Archive anything, or bring something back
- Apply a rule to past transactions. It can write a rule; running one over
  history overwrites categorizations you made by hand, so that stays a button
  you press
- Read or change settings, users, two-factor, remote access, sync or Bitcoin
- Create another connection, or switch one off

These are refused by Delegate itself, not by the assistant's good behaviour. A
connection asked to do one of them gets an error.

---

## Setting it up

### 1. Create a connection

In Delegate, go to **Settings → Connections**.

Give it a name you will recognise later — "Claude on the laptop" — decide
whether it may make changes, choose an expiry, and press **Create connection**.

The key is shown once. Copy it now; Delegate stores only a fingerprint of it and
cannot show it again. If you lose it, switch that connection off and make
another.

### 2. Build the connector

On the computer that will run it, from a checkout of this repository:

```sh
npm install && npm run build --workspace @budget/mcp
```

### 3. Tell Claude about it

**Claude Code** — from the repository directory:

```sh
claude mcp add delegate --env DELEGATE_URL=http://10.0.3.4:8088 --env DELEGATE_TOKEN=dlg_... -- node apps/mcp/dist/server.js
```

**Claude Desktop** — open Settings → Developer → Edit Config, and add a
`delegate` entry under `mcpServers`. Use absolute paths; the desktop app does
not start in your repository.

```json
{
  "mcpServers": {
    "delegate": {
      "command": "node",
      "args": ["/Users/you/Documents/Claude/Projects/delegate/apps/mcp/dist/server.js"],
      "env": {
        "DELEGATE_URL": "http://10.0.3.4:8088",
        "DELEGATE_TOKEN": "dlg_..."
      }
    }
  }
}
```

Restart Claude Desktop afterwards. Claude Code picks it up immediately.

### 4. Check it

Ask Claude: _"what's the balance on my budget?"_ It should come back with the
reading from the top of the Budget page.

---

## Settings

| Variable              | Required | What it is                                     |
| --------------------- | -------- | ---------------------------------------------- |
| `DELEGATE_URL`        | yes      | Where Delegate is, e.g. `http://10.0.3.4:8088` |
| `DELEGATE_TOKEN`      | yes      | The key from Settings → Connections            |
| `DELEGATE_TIMEOUT_MS` | no       | How long to wait for a reply. Default 15000    |

The token lives in the assistant's configuration file and nowhere else. Nothing
here writes it anywhere.

---

## When it does not work

**Claude does not list any Delegate tools.** The connector failed to start.
Claude Desktop keeps its logs in `~/Library/Logs/Claude/`; the connector writes
the reason there. The usual causes are a relative path in the config, or a
`DELEGATE_URL` the computer cannot reach.

**"Delegate refused the token."** It has been switched off, has expired, or was
copied incompletely. Check Settings → Connections and issue a new one.

**"This token is read-only."** The connection was created without **Allow
changes**. That cannot be changed after the fact — create a new connection and
switch the old one off.

**"Could not reach Delegate."** Check `DELEGATE_URL` from that computer:

```sh
curl -sS http://10.0.3.4:8088/health
```

Note that the Tor onion address will not work here. Tor requires a proxy the
connector does not use, and remote access over Tor is off unless it has been
switched on from the LAN.

---

## Notion

Notion can connect to a custom MCP server, but only on a Business or Enterprise
plan, and only through a Notion **Custom Agent**. It also requires the server to
be reachable over public HTTPS with OAuth, which the connector described here
deliberately is not — it runs on your machine and speaks to Delegate over your
home network.

Reaching Notion means the remote transport described in ADR 031 as explicitly
out of scope: an OAuth authorization server inside Delegate, and a `/mcp`
endpoint published through the Cloudflare Tunnel. That is a decision with an ADR
in front of it, not a configuration change.
