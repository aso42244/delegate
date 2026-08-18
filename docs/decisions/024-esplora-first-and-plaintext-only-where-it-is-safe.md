# 024. Esplora first, and plaintext only where it is safe

**Status:** accepted
**Date:** 2026-08-18

## Context

Watching a wallet means asking somebody "what has this address received and
spent?" Two protocols answer that: **Esplora** over HTTP, and **Electrum** over a
raw TLS socket. The owner's requirements were LAN, Tor, and WAN over HTTPS rather
than HTTP.

## Decision

**Esplora first.** One HTTP client reaches all three: public services
(mempool.space, blockstream.info), a self-hosted node on the LAN (`electrs` and
mempool.space both serve this shape), and either of those over an onion address.
Electrum would answer the same question and require a socket client, a TLS
handshake and scripthash encoding to do it — a second implementation of one idea,
deferred until this one is proved.

**Plaintext is permitted only to an onion address or a private one.** The rule is
checked when a URL is _stored_, not when it is used, so a public endpoint saved
over `http` cannot sit there looking fine and then send every address lookup
across the internet in the clear the first time something scans a wallet.

Two exceptions, neither of which weakens it:

- **`.onion`.** A v3 onion name _is_ a public key. The transport is already
  end-to-end encrypted and authenticated by the address itself; TLS on top adds
  nothing, and certificate authorities do not meaningfully issue for `.onion`.
  Requiring https would rule out Tor entirely.
- **A private address.** A LAN node serves plaintext. Putting a self-signed
  certificate in front means pinning one to gain nothing against an attacker
  already inside the network — the same trade ADR 017 made for Delegate itself.

**Confirmed balances only.** The mempool figures are read and discarded. A
holding that moved with unconfirmed transactions would flicker between syncs for
money that has not settled, which is the same reasoning as reading a bank's
settled balance rather than its available one — and the same reasoning behind the
pending term in ADR 020.

**The privacy cost is stated beside the choice**, not in a footnote. A public
server learns every address Delegate asks it about and can keep them, which over
time is the whole wallet. Tor removes the IP address; it does not remove the
linkage. The only real answer is your own node, and the interface says so where
the endpoint is picked.

## Consequences

Requests go out four at a time. A gap-limit scan asks about twenty addresses to
find one, and firing all of them at a free public service is how a household
budget gets rate limited.

The client takes its `fetch` as a parameter. Node's own cannot speak SOCKS, so
routing over Tor is a different dispatcher rather than a different client — which
is what makes that a later phase rather than a rewrite.

Nothing here derives addresses. This asks about addresses it is given, so it
could be proved on its own before anything depended on it.
