# syntax=docker/dockerfile:1

# Built by CI on x86_64 runners, never on the development Mac: a Mac produces an
# arm64 image and the DS220+ is an Intel Celeron. See ADR 005.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so the dependency layer is reused whenever only source
# changes — which is most of the time.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npx prisma generate --schema apps/api/prisma/schema.prisma && npm run build

# Reinstalled without dev dependencies rather than pruned, so the runtime layer
# carries no build toolchain. The Prisma client is regenerated afterwards because
# the reinstall replaces node_modules wholesale.
#
# `npx prisma` directly, not `npm run db:generate`: that script routes through
# dotenv-cli, which is a devDependency and is gone by this point.
RUN npm ci --omit=dev && npx prisma generate --schema apps/api/prisma/schema.prisma

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# postgresql17-client provides pg_dump and pg_restore for the nightly backup.
# The client is version-tolerant and Alpine ships one version; the server is
# Postgres 16, which a newer client reads without trouble.
RUN apk add --no-cache postgresql17-client tini

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY scripts ./scripts

# Runs unprivileged. The node image ships a `node` user for exactly this.
RUN mkdir -p /backups && chown -R node:node /app /backups
USER node

EXPOSE 3000

# tini as PID 1 so SIGTERM reaches Node: without an init, a container stop can
# kill the process mid-write rather than letting it shut down cleanly.
ENTRYPOINT ["/sbin/tini", "--"]

# Shell form, so TLS_CERT_PATH is read at run time rather than baked in: the same
# image serves plain http or https depending only on configuration (ADR 017).
# --no-check-certificate because a self-signed certificate is the expected case,
# and this checks that the app is up, not who it claims to be.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD if [ -n "$TLS_CERT_PATH" ]; then \
        wget --quiet --tries=1 --no-check-certificate --spider https://localhost:3000/health || exit 1; \
      else \
        wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1; \
      fi

# Migrations are applied on start. Prisma takes an advisory lock, so this is safe
# even if two containers ever start at once.
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && node apps/api/dist/server.js"]
