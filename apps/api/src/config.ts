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

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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

  // A bearer credential for the household's bank data: it embeds Basic Auth and
  // anyone holding it can read every transaction. Empty is valid — the app runs
  // without it and reports sync as unconfigured.
  SIMPLEFIN_ACCESS_URL: z.string().default(''),
  SIMPLEFIN_SYNC_CRON: z.string().default('0 * * * *'),
  SIMPLEFIN_BACKFILL_MONTHS: z.coerce.number().int().positive().max(24).default(12),
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
