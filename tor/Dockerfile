# Tor, built here rather than pulled from a stranger.
#
# This replaces `dperson/torproxy:latest`: a third-party image on a mutable tag,
# started by default, and positioned to see every Bitcoin address this household
# looks up and every byte of an inbound onion connection. It also silently
# ignored the configuration mounted into it — that image ships its own
# entrypoint script, so `command:` became arguments *to* it rather than a
# replacement *for* it, and the hidden service was never created. Owning the
# image is what makes the configuration actually apply.
#
# What is left is Alpine's own `tor` package from Alpine's signed repositories,
# and nothing else.
FROM alpine:3.21

# `su-exec` is a 10KB setuid-free `gosu`: it drops privileges and execs, without
# leaving a shell between tor and PID 1.
RUN apk add --no-cache tor su-exec

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Root only long enough to fix ownership of the mounted volume, then tor runs as
# `tor`. See entrypoint.sh for why that cannot be done with `USER` alone.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
