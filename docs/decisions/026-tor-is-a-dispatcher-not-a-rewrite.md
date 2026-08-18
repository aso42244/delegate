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

**An onion address cannot be saved with Tor off.** It has no route except through
the proxy, so storing that combination would store a node that can never answer —
and the owner would discover it as a scan failure days later rather than as a
refusal while the URL is still on screen.

**The Tor container is opt-in.** It sits behind a compose profile:

    docker compose --profile tor up -d

A household that has no use for Tor should not run a Tor daemon, and `docker
compose up -d` on its own does not start one. It publishes no ports; only the app
container reaches it, over the compose network, which is the whole of its job.

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
