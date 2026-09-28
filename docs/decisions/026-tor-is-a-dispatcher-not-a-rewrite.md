# 026. Tor is a dispatcher, not a rewrite

**Status:** accepted
**Date:** 2026-08-18

## Context

The owner required Tor as one of three ways to reach a Bitcoin node. Node's own
`fetch` cannot speak SOCKS, which is the only thing standing between the existing
Esplora client and an onion service.

## Decision

`EsploraNode` already takes its `fetch` as a parameter — that was done in ADR 024
precisely so this phase would be a parameter rather than a fork. Tor is therefore
a `Dispatcher` built from `undici` and the `socks` library, and the client is
unchanged.

**`socks5h`, not `socks5`.** The hostname goes to the proxy rather than being
resolved here, and that is not a preference:

- A `.onion` name has no DNS entry at all, so resolving locally simply fails.
- For any other host, resolving locally would announce which host is being asked
  about to the network Tor exists to hide it from — the leak would be the DNS
  query rather than the connection.

**TLS is negotiated through the tunnel, not to it.** An https node reached over
Tor stays end-to-end encrypted to the node, and the proxy carries a stream it
cannot read. The certificate is checked against the node.

**The address decides the route. There is no setting.**

| what is typed     | route                                   | why there is no choice to make                                                                    |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| a private address | direct                                  | Tor would route around the house to get back into it, and hide nothing from anyone already inside |
| an onion address  | Tor                                     | it has no other route in existence                                                                |
| anything else     | Tor first, direct if Tor is unreachable | Tor hides which household is asking; a hidden IP address is not worth a missing balance           |

This was first built as a checkbox — twice. First as "reach it over Tor" with a
refusal behind it, then as "reach it over Tor anyway" for public nodes. Both were
the same mistake: asking the owner to answer a question the address had already
answered, in vocabulary (_SOCKS proxy_) that belongs to the implementation.

**The fallback is never silent.** Which route a request actually took is recorded
and shown — "answered over Tor" and "answered directly" are different facts, and
only one of them is what asking for Tor meant. Without that the interface would
report success while having no idea whether the household's IP address was hidden
or handed over.

**Only a transport failure falls back.** A node that answered and said no — a 404,
a 500 — is reported as it is. Retrying that directly would take a request Tor
completed perfectly well and send it again over the open internet, which is the
exact opposite of what choosing Tor meant. The route is also decided once per
client and then kept: a gap-limit scan makes dozens of requests, and retrying Tor
on each would double every one.

**The address is worked out, not demanded.** The box takes a LAN address, a
domain name or an onion address, with or without a scheme and with or without the
API path. Requiring all three means requiring somebody to know that mempool.space
serves Esplora under `/api` while their own `electrs` might not — which a program
can simply find out. Candidates are probed on save and the one that answers is
what gets stored, so the setting is a URL that has been proved rather than one
that looked plausible. A node that does not answer is still saved, with the
failure recorded: being unable to configure a node because it happens to be down
would be worse than saying so.

**The Tor container runs by default.** It was behind a compose profile at first,
for the sake of not running a small idle daemon on a household that has no use
for one. That is the wrong trade: it meant pasting an onion address silently did
nothing until the deployment notes had been read. Nothing routes through the
proxy unless a node is configured to, it publishes no ports, and only the app
container reaches it over the compose network.

When the proxy is missing, the check says so specifically — a failure to reach
Tor and a failure to reach the node read almost identically at that level, and
the fix for each is entirely different.

## Consequences

Tor is slower — several hops, by design. Wallet scans are already sequential and
already hourly, so this is felt at the "scan now" button rather than anywhere
that matters.

The proxy is a second container to keep running on the NAS. When it is not
running and a node is configured to use it, the scan fails and the failure is
recorded on the wallet, where the interface already shows it — the same shape as
any other unreachable node.

Tor hides _who is asking_. It does not hide _what is being asked about_ from the
node itself: a public Esplora server still learns every address, and still gets
to keep them. Tor removes the link to a household's IP address; it does not
remove the link between the addresses. That was said in ADR 024 and is worth
repeating, because "I use Tor" is exactly the belief that makes a public server
feel safe when it is not.
