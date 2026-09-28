# 025. A descriptor is the one wallet representation

**Status:** accepted
**Date:** 2026-08-18

## Context

The owner asked to watch a wallet by `xpub`, `ypub` or `zpub`, and to import a
descriptor for a multisig. Those look like four features. They are one.

An `xpub`, a `ypub` and a `zpub` are the _same key material_ with different
version bytes. The version bytes carry only the intended script type — legacy,
SegWit wrapped in P2SH, and native SegWit. A descriptor states that outright.

## Decision

**Convert on the way in; store a descriptor.** Each prefix is rewritten to a
plain `xpub` and wrapped in the descriptor that says what its version bytes
implied:

| pasted       | becomes               | addresses        |
| ------------ | --------------------- | ---------------- |
| `xpub…`      | `pkh(xpub…/0/*)`      | `1…`             |
| `ypub…`      | `sh(wpkh(xpub…/0/*))` | `3…`             |
| `zpub…`      | `wpkh(xpub…/0/*)`     | `bc1q…`          |
| a descriptor | itself                | whatever it says |

One representation means one derivation path through the code. Keeping the
distinction as a flag would mean every reader re-deriving what it meant, and
disagreeing eventually.

**Derivation is not hand-rolled.** `@bitcoinerlab/descriptors` does it, and the
tests check it against the published BIP44, BIP49 and BIP84 vectors with the
expected addresses written out. This is the one place in the application where
being subtly wrong produces output that is perfectly well-formed and belongs to
somebody else: a wrong path or a mis-ordered `sortedmulti` gives real addresses
for a wallet that is not yours, and the symptom is "it says I have nothing"
rather than an error.

**The descriptor is encrypted at rest**, with the same AES-256-GCM machinery as
the SimpleFIN credential. It cannot spend, so this is not about theft — it
reveals every address the wallet will ever use, permanently, which is a more
durable loss than a balance. The database is dumped nightly. The API never
returns it, and the interface identifies a wallet by its first receive address
instead: that address is public by construction, so showing it costs nothing.

**The gap limit is twenty, and stopping is the point.** A scan derives, asks, and
stops once twenty consecutive addresses have never been used. Every wallet agrees
on that number, which is exactly what makes a wallet restored elsewhere find the
same coins — so finding a coin beyond the gap would mean disagreeing with the
wallet that made it. Both behaviours are tested: the run resets on a used
address, and it genuinely stops when the gap closes first.

**A scan writes an event, not a quantity.** It reconciles the difference into the
holdings ledger from ADR 023, so a wallet-derived balance and a hand-entered
purchase live in one history and the net worth chart reads one thing. A scan that
finds no change writes nothing at all — an hourly job recording a zero-value
event every hour would bury the history it exists to keep.

## Consequences

A scan can only say _how much_, never _what it cost_. Its events carry no price,
so wallet-derived Bitcoin lands in the unpriced pool of the cost basis and is
reported as "held at an unknown cost" rather than as free. Recording what was
actually paid stays a manual act, because only the owner knows it.

Wallets are scanned sequentially on the hourly job, and one failure does not stop
the rest. They go to a single node, often a free public one, and firing every
wallet's gap scan at it at once is how a household budget gets rate limited.

A single-path descriptor has its change chain inferred by rewriting `/0/*` to
`/1/*`. A wallet exporting the multipath `<0;1>` form is understood directly, and
every key in it is rewritten rather than the first — a multisig carries the
marker once per co-signer, and rewriting one produces a descriptor that mixes
chains, parses cleanly, and derives somebody else's addresses.
