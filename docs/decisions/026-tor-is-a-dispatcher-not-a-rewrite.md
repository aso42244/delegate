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

**Tor is inferred from the address, not asked about.** An onion address has no
DNS entry and no route except through the proxy, so whether to use Tor is not a
question about one — it is a fact about one. Asking would be asking the owner to
restate what he has already typed, and only one of the two answers works.

This was first built as a checkbox with a refusal behind it, which was wrong in a
way worth recording: it turned "paste the address of my node" into "paste the
address, know what a SOCKS proxy is, tick the right box, and start a second
container first". Everywhere other than an onion address Tor stays a genuine
choice, because reaching a clearnet node through it hides which household is
asking.

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
