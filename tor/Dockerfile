# Tor, built here rather than pulled from a stranger.
#
# This replaces `dperson/torproxy:latest`, which was a third-party image on a
# mutable tag, started by default, and positioned to see every Bitcoin address
# this household looks up — and every byte of an inbound onion connection. A
# `latest` tag from an unrelated maintainer is a standing invitation to run code
# nobody here has looked at, on exactly the traffic that most wants looking after.
#
# What is left is Alpine's own `tor` package, installed from Alpine's signed
# repositories, running as Alpine's own `tor` user. Nothing else is in the image.
FROM alpine:3.21

RUN apk add --no-cache tor \
  # The hidden service's key material lives here. Tor refuses to start unless it
  # owns the directory and nobody else can read it, which is the correct
  # paranoia and worth stating rather than discovering.
  && mkdir -p /var/lib/tor \
  && chown -R tor:tor /var/lib/tor \
  && chmod 700 /var/lib/tor

USER tor

# The configuration is mounted read-only by compose; it is part of the release
# rather than state.
ENTRYPOINT ["tor", "-f", "/etc/tor/torrc"]
