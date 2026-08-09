# Dependencies

What Delegate depends on, why, and how it gets updated.

The list is deliberately short. Every package here is something that would be
unreasonable to write by hand — a database driver, a password hash, a QR encoder
— rather than something that saved an afternoon.

## What ships

| Package                                  | Why it is here                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fastify` and its `@fastify/*` plugins   | HTTP server, cookies, sessions, static files, rate limiting, security headers.                                                                                               |
| `@prisma/client`, `prisma`               | Database access and forward-only migrations (ADR 003).                                                                                                                       |
| `argon2`                                 | Password and recovery-code hashing (ADR 007). A native binding, so it is pinned to a version with prebuilt binaries for the CI image.                                        |
| `otplib`                                 | TOTP generation and verification (ADR 014).                                                                                                                                  |
| `zod`                                    | Request validation at the HTTP edge.                                                                                                                                         |
| `node-cron`                              | The sync, price and backup schedules.                                                                                                                                        |
| `pino`                                   | Structured logs.                                                                                                                                                             |
| `react`, `react-dom`, `react-router-dom` | The client.                                                                                                                                                                  |
| `@tanstack/react-query`                  | Server state in the client.                                                                                                                                                  |
| `qrcode`                                 | Renders the enrolment QR **locally**. The `otpauth://` URI contains the shared secret, so sending it to a QR service would hand over the second factor it exists to protect. |
| `tailwindcss`                            | Styling.                                                                                                                                                                     |

Everything else in `package.json` is a build or test tool and never reaches the
running container.

## Audit

CI runs two checks on every push:

- `npm audit --omit=dev --audit-level=high` — **fails the build**. A high or
  critical advisory in something that ships is a reason to stop.
- `npm audit` over everything — reported, never fails. An advisory in a test
  runner is a reason to read, not a reason to block a fix to the budget.

Run the same locally:

```bash
npm audit --omit=dev --audit-level=high
```

## Updating

Patch and minor updates, roughly monthly and always before a release tag:

```bash
npm update && npm run typecheck && npm run lint && npm test && npm run test:integration && npm run test:e2e
```

Integration and end-to-end tests share `TEST_DATABASE_URL` and truncate it, so
they must never run at the same time — the command above is sequential for that
reason.

Major updates are done **one package at a time**, on their own branch, with the
changelog read first. The ones that need care:

- **Prisma** — regenerate the client (`npm run db:generate`) and apply migrations
  to both the development and the test database. Migrations are hand-written and
  applied with `migrate deploy`; `migrate dev` is interactive and hangs.
- **otplib** — the v12 `authenticator` singleton and the v13 functional API are
  entirely different shapes. `epochTolerance` is in **seconds**, not steps.
- **Fastify** — plugin major versions are tied to the server major version;
  upgrade the set together or the plugin registration fails at boot.
- **argon2** — a native module. Confirm a prebuilt binary exists for the
  container's platform, or the image build starts compiling.

After any dependency change, rebuild and re-run the container health check that
CI performs, because a runtime failure in a native module does not show up in a
type check.

## Adding one

Prefer the standard library. Reach for a package when the alternative is
implementing cryptography, a wire protocol, or a specification by hand. Anything
new that ships gets a row in the table above, with the reason — not the feature
it enabled, but why writing it here would have been the wrong call.
