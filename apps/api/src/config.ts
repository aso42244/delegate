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

    // Optional TLS, terminated by the application itself. Both paths or neither;
    // see ADR 017. Left empty, Delegate serves plain http, which is the default
    // and is only acceptable on a trusted LAN.
    TLS_CERT_PATH: z.string().default(''),
    TLS_KEY_PATH: z.string().default(''),

    // Extra origins allowed to make state-changing requests, comma separated
    // (e.g. https://budget.example). The server's own Host always counts, so a
    // direct LAN deployment needs nothing here; this exists for the day a reverse
    // proxy fronts it under a different name. See plugins/csrf.ts.
    TRUSTED_ORIGINS: z.string().default(''),

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
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100_000).default(10),
    AUTH_RATE_LIMIT_WINDOW: z.string().default('5 minutes'),

    // Bitcoin is held as a quantity; its worth is that quantity times the price on
    // the date being shown. Both endpoints are keyless and free, and hourly
    // polling sits far inside what either asks for. Offset from the hour so it
    // does not contend with the sync job on a two-core machine.
    BITCOIN_PRICE_CRON: z.string().default('5 * * * *'),
    BITCOIN_PRICE_PRIMARY: z.enum(['coingecko', 'coinbase']).default('coingecko'),
    BITCOIN_PRICE_FALLBACK: z.enum(['coingecko', 'coinbase']).default('coinbase'),

    // Nightly pg_dump. §14 puts this in Phase 1 rather than Phase 3, because data
    // loss during the move off the spreadsheet would be unrecoverable.
    BACKUP_DIR: z.string().default('./backups'),
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

  return { ...parsed.data, isProduction: parsed.data.NODE_ENV === 'production' };
}

/** The process-wide config, parsed on first use. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
