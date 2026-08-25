# 027. Remote access is an onion service, off by default

**Status:** accepted
**Date:** 2026-08-18

## Context

Delegate is reachable from away through a Cloudflare Tunnel. That works, and the
owner is happy with it — but it has one property worth naming plainly:
**Cloudflare terminates TLS**. Every balance, every transaction description, the
session cookie, and the password at the moment it is typed exist in plaintext
inside somebody else's edge network. That is the deal every tunnel provider
makes; it is not a fault in the setup.

The owner asked whether end-to-end encryption could remove that. It could, and
the cost is the application: the identity is a SQL `SUM`, the budget view, the
Delegate run, insights, net worth and cost basis are all computed server-side,
and the hourly SimpleFIN sync needs the bank credential in the clear to make its
call. Encrypting the amounts moves all of that into the browser and reduces sync
to "whenever a tab is open".

An onion service removes the same intermediary for a fraction of that.

## Decision

**A Tor hidden service, alongside the SOCKS proxy that already exists.** Onion
port 80 forwards to the app. A v3 onion address _is_ an ed25519 public key, so
the connection is encrypted and authenticated end to end between the phone and
the NAS, with nobody in the middle holding plaintext. No port forward, no domain
name, no certificate, no provider.

**The address existing does not open the budget.** `remote_over_tor_enabled`
defaults false, and while it is false a request arriving on the onion address is
refused before it reaches a route. An onion address is 56 unguessable characters
with no DNS record and no certificate transparency entry, so nothing finds it by
scanning — but _unguessable_ and _closed_ are different properties, and only one
of them survives the address being screenshotted, bookmarked on a lost phone, or
read aloud.

Turning it on is therefore possible from exactly one place: the LAN, where the
refusal does not apply. That is the "requires LAN setup initially" the owner
asked for, enforced rather than documented.

**The test is the `Host` header.** A Tor Browser asking for `abc…xyz.onion` sends
exactly that, and nothing on the local network does. It also makes the CSRF
origin check work over Tor with no configuration, because origin and host agree
by construction.

Two routes are exempt: `/health`, because a health check that fails when the door
is shut is one nobody can read, and logout, because a remote device holding a
session must be able to drop it.

## Consequences

**The hidden service key is the address.** It lives in a named volume; lose it
and the address cannot be recovered, only replaced — and every device that had it
bookmarked stops working. It belongs in whatever backs up the NAS, and it is
worth guarding: anyone holding it can impersonate this service.

**Tor is slower**, and reaching it means Tor Browser, or Onion Browser on iOS.
That is the price of no intermediary.

**Running both doors sets your security to the weaker one.** Cloudflare Tunnel
and an onion service are two ways in, and the tunnel is the one that terminates
TLS somewhere else. The strongest configuration is the onion service alone, with
the tunnel kept as a break-glass path — but that is an operator's decision, and
nothing here forces it.

**What it does not fix.** The password and the second factor remain the only
things between an authorised device and the money. Tor hides _who_ is asking; it
does not authenticate _which household member_ is asking. Tor's own client
authorization would add a per-device key at the network layer, before the login
page is reachable at all — not built here, and the obvious next step if this is
wanted.

## Addendum, 2026-08-18: it runs itself, and the first version did not run at all

Two corrections, both found by the address never appearing.

**The third-party image ignored the configuration.** `dperson/torproxy` ships its
own entrypoint script, so the `command:` in compose became arguments _to_ that
script rather than a replacement _for_ it. The mounted `torrc` — the file that
defines the hidden service — was never read. The proxy worked, which is why
nothing looked wrong, and no onion address was ever created. Owning the image is
what makes the configuration apply, which is a better reason to own it than the
supply-chain one.

**An existing volume keeps its ownership.** Docker copies ownership from the
image only when it _creates_ a named volume. `tor-keys` had already been created
by that earlier image running as root, so a container running as `tor` could not
write to it — and tor refuses to touch a `HiddenServiceDir` it does not own,
correctly, because the key in there is the entire identity of the address. The
entrypoint now chowns and drops privileges, which handles both a fresh volume and
one inherited from the older version.

**Nothing is started by hand.** Tor is an ordinary compose service and comes up
with everything else; the setting in the interface decides whether requests
arriving on the address are _answered_, which is a different question from
whether the service exists. The interface said "start the tor service on the
NAS", which was wrong twice over — it starts itself, and saying otherwise is how
somebody concludes a working system is broken.

**The health check tests the hostname file** rather than the SOCKS port. The port
answered throughout the failure above; the thing that was missing was the hidden
service, and that is what the file's existence proves.

## Amendment, 2026-08-25

**While remote access is off, the onion address answers an empty 404 and nothing
else.**

It used to answer `403` with a plain explanation — "Remote access over Tor is
switched off. Turn it on from Settings → … while on the home network." The
reasoning written down at the time was that whoever read it was overwhelmingly
likely to be the household on their own phone, having forgotten. That is probably
true, and it is the wrong trade, because of who _else_ it can be.

Anyone reaching this holds the address. To them that reply confirmed four things:
that a service is really there, that it is this application, that remote access
is a feature of it, and that it is currently off — which is to say the address is
live and worth keeping for later. None of those survive an empty 404. Off is
indistinguishable from nothing ever having been there.

**`/health` and `/api/auth/logout` are no longer exempt**, and the health
exemption was the louder leak of the two: a `200` confirms a live service
unconditionally, whatever the switch says. It was exempt so a health check would
keep working, which sounded reasonable and bought nothing — Docker's own check
runs inside the compose network and never carries an onion `Host`. Logging out
was exempt so a remote device could drop its session; a session that cannot reach
anything does not need ending from there, and it can be ended from the LAN or by
changing a password, which revokes every other session outright.

The refusal is still logged at `warn` on the server, where the household can read
it and nobody else can. What they lose is a hint they can get from the LAN in one
tap, on the page that holds the switch.
