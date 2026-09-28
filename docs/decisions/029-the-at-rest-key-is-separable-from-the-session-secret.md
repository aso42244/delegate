# 029. The at-rest key is separable from the session secret

**Status:** accepted
**Amends:** ADR 011

## Context

ADR 011 derived the AES-256-GCM key from `SESSION_SECRET` with scrypt, to avoid a
second mandatory environment variable. The stated cost was that rotating
`SESSION_SECRET` would make the SimpleFIN credential undecryptable, recovered by
pasting the token again.

That cost grew. Three kinds of secret are now encrypted with that key: every
account's TOTP secret, the SimpleFIN credential, and every watched wallet's
descriptors. Rotating `SESSION_SECRET` would take out all of them at once —
including the second factors, which are not recoverable by pasting anything.

So the one moment you would most want to rotate a session secret, a suspected
compromise, is the moment it costs the most. That is pressure never to rotate,
which is the opposite of what a secret is for.

## Decision

`DATA_ENCRYPTION_KEY`, optional, resolved once into `config.dataKey`:

    dataKey = DATA_ENCRYPTION_KEY || SESSION_SECRET

**The fallback is not a convenience, it is a requirement.** Every deployment made
before this wrote its ciphertext under the derived key and has to keep reading it
that way. Nothing changes for anyone who does not set the variable.

**Resolved once, in `loadConfig`.** Call sites take `config.dataKey`, never
either environment variable, so nothing can encrypt with one and decrypt with the
other. Session signing, the second-factor challenge and the used-code HMACs stay
on `SESSION_SECRET` — they are session-layer and short-lived, and coupling them
to the at-rest key would recreate the problem in the other direction.

**`npm run secrets:rekey` moves an existing deployment**, reading with the key in
force and writing under `DATA_ENCRYPTION_KEY_NEW`, in one transaction. It reads
_everything_ before writing _anything_, so a key that cannot open one row is
found while the database is untouched. `--check` does the reading half alone.

## Consequences

Rotating `SESSION_SECRET` is now an ordinary act for anyone who has run the
re-key: it invalidates live sessions, which is the point, and touches nothing at
rest.

Setting `DATA_ENCRYPTION_KEY` _without_ running the re-key makes every stored
secret unreadable. The application says so specifically when it happens, and the
README leads with the order.

The fixed scrypt salt from ADR 011 is unchanged and still acceptable: there is
one key, derived from a high-entropy secret rather than a memorable one, so there
is nothing for a precomputed table to attack.

**Rehearsed before shipping.** The command was run against a database holding one
of each kind of secret. It found two real defects that reading the code had not:
the wallet path packed two descriptors into JSON and then tried to parse the
_encrypted_ result, and the writes closed over the global client rather than the
transaction — so nothing was actually atomic, and a failure halfway would have
left some secrets on the new key and some on the old. Both fixed, then verified:
every value read back correctly under the new key, and the old key opened none of
them.
