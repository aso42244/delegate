import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Environment parsing and validation.
 *
 * Validated once at startup and never read from `process.env` again, so a missing
 * or malformed value fails immediately with a readable message rather than
 * surfacing as `undefined` somewhere deep in a request three days later.
 */

loadDotenv({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });

const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .describe('"true" or "false"');

/**
 * The IANA zones this runtime knows, plus UTC.
 *
 * `Intl.supportedValuesOf` lists the canonical region zones and deliberately
 * omits `UTC`, so it is added back — it is the default here and has to be
 * spellable.
 */
const KNOWN_TIME_ZONES = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);

/**
 * Whether a string names a real IANA zone.
 *
 * Stricter than `new Intl.DateTimeFormat({ timeZone })`, which also accepts
 * abbreviations like `CST` and fixed offsets like `-05:00`. Both are refused
 * here, because neither carries daylight saving rules: a job set for half past
 * two in the morning against an offset runs at half past one for half the year,
 * and `CST` names two different zones on two different continents.
 *
 * A typo would otherwise be silent in the worst way available — an unknown zone
 * falls back to the process default, so the job still runs, just never at the
 * hour the operator set.
 */
function isKnownTimeZone(zone: string): boolean {
  return KNOWN_TIME_ZONES.has(zone);
}

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // The name shown in the sidebar. Configurable so a household can title it
    // whatever it likes — including a family name, which must never reach a
    // repository that may go public. See docs/design.md, decision 6.
    APP_NAME: z.string().min(1).max(60).default('Delegate'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // 32 bytes is the floor for a signing key that protects a financial
    // application's sessions. Generate with: openssl rand -base64 48
    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters. Generate: openssl rand -base64 48'),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),

    // Must stay false until TLS lands in Phase 3: a Secure cookie is never sent
    // over plain http, so flipping this early makes login fail silently rather
    // than loudly.
    SESSION_COOKIE_SECURE: booleanFromString.default(false),

    /**
     * The key protecting secrets at rest, kept apart from the one that signs
     * sessions.
     *
     * Empty — the default — derives it from `SESSION_SECRET`, which is what
     * every existing deployment does and must keep doing, because the stored
     * ciphertext was written that way. Setting it separates the two, so
     * `SESSION_SECRET` can be rotated after a suspected compromise without also
     * making every TOTP secret, the bank credential and every wallet descriptor
     * undecryptable at the same moment. That coupling was the reason never to
     * rotate either.
     *
     * Moving an existing deployment onto one is `npm run secrets:rekey`, which
     * re-encrypts everything in a single transaction. Setting this without
     * running that leaves the data unreadable — the command refuses to leave it
     * that way, and the README says so.
     */
    DATA_ENCRYPTION_KEY: z.string().default(''),

    // Whether to believe `X-Forwarded-For`, and from whom.
    //
    // Empty (the default) means the connecting socket is the client, which is
    // correct when nothing sits in front. Behind a Cloudflare Tunnel it is wrong
    // in a way that matters: every request appears to come from `cloudflared`, so
    // the sign-in rate limit becomes one shared bucket for the whole internet.
    //
    // Accepts `true`, or a comma-separated list of addresses and CIDR ranges to
    // trust. See ADR 018 — this is opt-in because a header is only evidence when
    // something trustworthy set it.
    TRUST_PROXY: z.string().default(''),

    // Optional TLS, terminated by the application itself. Both paths or neither;
    // see ADR 017. Left empty, Delegate serves plain http, which is the default
    // and is correct when something else terminates TLS in front — a tunnel, a
    // reverse proxy, or an onion service, where the address itself is the key.
    TLS_CERT_PATH: z.string().default(''),
    TLS_KEY_PATH: z.string().default(''),

    // Extra origins allowed to make state-changing requests, comma separated
    // (e.g. https://budget.example). The server's own Host always counts, so a
    // direct LAN deployment needs nothing here; this exists for the day a reverse
    // proxy fronts it under a different name. See plugins/csrf.ts.
    TRUSTED_ORIGINS: z.string().default(''),

    /**
     * The time zone every cron expression below is read in.
     *
     * Governs *when* scheduled jobs fire and nothing else. The process itself
     * stays on whatever `TZ` it was given — deliberately, because moving the
     * process clock would also move every date the domain computes, and dates
     * here decide which month a transaction lands in and which day a Bitcoin
     * holding is valued on. A backup running an hour earlier is a preference; a
     * transaction changing months is a defect.
     *
     * Defaults to UTC, which is what every deployment did before this existed,
     * so an upgrade changes nothing until somebody sets it.
     *
     * A household's time zone is a fact about that household, so the real value
     * belongs in `.env` rather than in this repository — the same reason
     * `APP_NAME` exists.
     */
    SCHEDULE_TIMEZONE: z
      .string()
      .default('UTC')
      .refine(isKnownTimeZone, {
        message:
          'SCHEDULE_TIMEZONE must be an IANA time zone name, such as "America/Chicago" or ' +
          '"UTC". Abbreviations ("CST") and fixed offsets ("-05:00") are refused: neither ' +
          'observes daylight saving, so a job set for a civil hour would drift.',
      }),

    // A bearer credential for the household's bank data: it embeds Basic Auth and
    // anyone holding it can read every transaction. Empty is valid — the app runs
    // without it and reports sync as unconfigured.
    SIMPLEFIN_ACCESS_URL: z.string().default(''),
    SIMPLEFIN_SYNC_CRON: z.string().default('0 * * * *'),
    SIMPLEFIN_BACKFILL_MONTHS: z.coerce.number().int().positive().max(24).default(12),

    // Attempts allowed per address per window on the routes that verify a
    // credential. Configurable so the test suites — which sign in hundreds of
    // times from one address — can raise it, while a dedicated test lowers it and
    // proves the limit actually bites. Ten in five minutes is generous for two
    // people and useless for a guessing loop.
    // A ceiling on every route, far above what two people generate. The
    // credential routes keep their own much stricter limit on top of it.
    GLOBAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(1_000_000).default(1_200),

    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100_000).default(10),
    AUTH_RATE_LIMIT_WINDOW: z.string().default('5 minutes'),

    // Bitcoin is held as a quantity; its worth is that quantity times the price on
    // the date being shown. Both endpoints are keyless and free, and hourly
    // polling sits far inside what either asks for. Offset from the hour so it
    // does not contend with the sync job on a two-core machine.
    BITCOIN_PRICE_CRON: z.string().default('5 * * * *'),
    BITCOIN_PRICE_PRIMARY: z.enum(['coingecko', 'coinbase']).default('coingecko'),
    BITCOIN_PRICE_FALLBACK: z.enum(['coingecko', 'coinbase']).default('coinbase'),

    // Where to find a SOCKS proxy when a node is reached over Tor. The default
    // is the compose service name, so the container next door works with no
    // configuration at all. Only used when the node setting says to.
    TOR_SOCKS_URL: z.string().default('socks5h://tor:9050'),

    // Nightly pg_dump. §14 puts this in Phase 1 rather than Phase 3, because data
    // loss during the move off the spreadsheet would be unrecoverable.
    BACKUP_DIR: z.string().default('./backups'),

    /**
     * The same directory, named as the *host* knows it.
     *
     * `BACKUP_DIR` is the path inside the container, and inside the container
     * that is the only true one — but it is no use to somebody standing on the
     * NAS looking for the file, which is exactly what a person chasing a missing
     * dump is doing. Compose knows both halves of the bind mount and passes this
     * one through; empty when nothing set it, and then the card shows the
     * container path as before rather than inventing a host path.
     */
    BACKUP_HOST_DIR: z.string().default(''),
    BACKUP_CRON: z.string().default('30 2 * * *'),
    BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(30),
  })
  // Half a TLS configuration is worse than none: the operator believes the
  // connection is encrypted and it is not. Refuse to start rather than serve
  // plain http under a name that suggests otherwise.
  .refine((env) => Boolean(env.TLS_CERT_PATH) === Boolean(env.TLS_KEY_PATH), {
    message: 'Set both TLS_CERT_PATH and TLS_KEY_PATH, or neither.',
    path: ['TLS_CERT_PATH'],
  });

export type AppConfig = Readonly<z.infer<typeof environmentSchema>> & {
  readonly isProduction: boolean;
  /**
   * The key secrets at rest are encrypted with: `DATA_ENCRYPTION_KEY` when one
   * is set, and `SESSION_SECRET` otherwise. Never read the two environment
   * variables directly for encryption — this is the only correct answer.
   */
  readonly dataKey: string;
};

let cached: AppConfig | undefined;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return {
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === 'production',
    // Resolved once here rather than at each call site, so nothing can encrypt
    // with one key and try to decrypt with the other.
    dataKey:
      parsed.data.DATA_ENCRYPTION_KEY === ''
        ? parsed.data.SESSION_SECRET
        : parsed.data.DATA_ENCRYPTION_KEY,
  };
}

/** The process-wide config, parsed on first use. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
