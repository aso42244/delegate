/**
 * `init-secrets` — makes the secrets this deployment needs, once.
 *
 * Runs before anything else starts, from a compose service that exits. Its whole
 * job is that **`docker compose up -d` works with no configuration at all**:
 * before this, `SESSION_SECRET` and `POSTGRES_PASSWORD` were both mandatory, so
 * the shortest possible install was "invent two secrets, write a file, then
 * start" — which is not a one-line deploy however short the last line is.
 *
 * Three rules, and each of them is load-bearing:
 *
 *  * **Never overwrite.** A secret regenerated on restart is every stored secret
 *    made unreadable and every account locked out. This only ever fills a gap.
 *  * **An environment variable wins.** Where one is set it is written into the
 *    file rather than replaced by a fresh value, so an existing deployment that
 *    already has `SESSION_SECRET` in `.env` keeps exactly the secret it has and
 *    upgrades without noticing this ran.
 *  * **Say what happened, never what was written.** The log says a key was
 *    created; it does not say what the key is.
 *
 * The files live in a volume of their own, deliberately **not** in the database.
 * The at-rest key protects data that a stolen `pg_dump` would otherwise hand
 * over in the clear, and a key stored beside the ciphertext it opens protects
 * nothing. The cost of that choice is real and is stated where somebody will
 * meet it: Settings shows the key, and the dump alone is not a whole restore.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the compose file mounts the secrets volume. */
const DEFAULT_DIR = '/secrets';

/**
 * 48 bytes, base64. Comfortably past the 32-character minimum the configuration
 * enforces, and the same shape as the `openssl rand -base64 48` the README has
 * always told people to run by hand.
 */
function generate(): string {
  return randomBytes(48).toString('base64');
}

/**
 * Writes a secret if it is not already there, and reports which happened.
 *
 * `seed` is the value to adopt rather than generate — an environment variable
 * this deployment already sets, or in one case a different secret entirely. Only
 * consulted when the file does not exist yet.
 *
 * `existsSync` then write is a race in the abstract and not here: this runs in a
 * one-shot container that every other service waits on, so nothing else is
 * looking at the directory while it works.
 */
function ensure(dir: string, file: string, seed: string): { value: string; created: boolean } {
  const path = join(dir, file);

  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing !== '') return { value: existing, created: false };
  }

  const value = seed.trim() || generate();

  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  // Set explicitly as well: `mode` on writeFileSync is masked by umask, and a
  // secret readable by anything else on the volume is not a secret.
  chmodSync(path, 0o600);

  return { value, created: true };
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * The setup token's alphabet: no O/0, no I/1/l.
 *
 * The same reasoning as the recovery codes. This one is read off a terminal and
 * typed into a browser by somebody who has just deployed something, and an
 * ambiguous character there costs a support conversation rather than a retry.
 */
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function setupToken(): string {
  const bytes = randomBytes(20);
  const letters = [...bytes].map((byte) => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]).join('');
  // Grouped for reading it back, and the groups are stripped on the way in.
  return `${letters.slice(0, 5)}-${letters.slice(5, 10)}-${letters.slice(10, 15)}-${letters.slice(15, 20)}`;
}

function main(): number {
  const dir = process.env['SECRETS_DIR'] ?? DEFAULT_DIR;
  mkdirSync(dir, { recursive: true });

  const created: string[] = [];

  // Order matters: the at-rest key falls back to whatever the session secret
  // resolved to, so the session secret has to be settled first.
  const session = ensure(dir, 'session-secret', env('SESSION_SECRET'));
  if (session.created) created.push('the session secret');

  /*
   * The at-rest key, and the one fallback in this file that is not simply
   * "adopt the variable of the same name".
   *
   * Before ADR 029 this key was *derived from* `SESSION_SECRET`, so on a
   * deployment that predates the split, every TOTP secret, the SimpleFIN
   * credential and every wallet descriptor is encrypted with that value. A fresh
   * random key here would be unable to read any of them — the application would
   * refuse to start, correctly, and the upgrade would look like a catastrophe.
   *
   * Seeding from the session secret instead makes the upgrade do nothing
   * visible and complete ADR 029 at the same time: the value is unchanged, so
   * no data is re-encrypted, and from now on the two are recorded separately —
   * which is the entire point of the split. `SESSION_SECRET` becomes rotatable
   * without touching anything at rest, and no `secrets:rekey` run is needed.
   *
   * A fresh install has no session secret to *inherit* — the one above was made
   * moments ago — so it gets a key of its own and the two are separate from the
   * first boot. Inheriting there would recreate the coupling this exists to end.
   */
  const predatesThisRun = env('SESSION_SECRET') !== '' || !session.created;
  const inherit = predatesThisRun ? session.value : '';
  const dataKey = ensure(dir, 'data-key', env('DATA_ENCRYPTION_KEY') || inherit);
  if (dataKey.created) created.push('the at-rest encryption key');

  const postgres = ensure(dir, 'postgres-password', env('POSTGRES_PASSWORD'));
  if (postgres.created) created.push('the database password');

  /*
   * The token that claims the first account.
   *
   * Shorter than the others and from an unambiguous alphabet, because unlike
   * them this one gets read off a terminal and typed into a browser. The
   * security it needs is "not guessable from outside the machine", which 20
   * characters of this alphabet is by a very wide margin.
   */
  const setup = ensure(dir, 'setup-token', env('SETUP_TOKEN') || setupToken());
  if (setup.created) created.push('the first-run setup token');

  /*
   * The connection string, assembled here because only this step knows the
   * generated password.
   *
   * Written as a whole URL rather than left for the compose file to build:
   * compose cannot read a file, so a password it never sees is a password it
   * cannot substitute. `APP_DATABASE_URL` still overrides everything downstream
   * — this is the default, not a decision.
   */
  const urlPath = join(dir, 'database-url');
  if (!existsSync(urlPath)) {
    const user = env('APP_DB_USER') || env('POSTGRES_USER') || 'postgres';
    const database = env('POSTGRES_DB') || 'delegate';
    const host = env('POSTGRES_HOST') || 'postgres';
    const password = postgres.value;

    // Percent-encoded: a generated base64 password contains `+` and `/`, both of
    // which mean something else inside a URL.
    const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:5432/${encodeURIComponent(database)}`;
    writeFileSync(urlPath, `${url}\n`, { mode: 0o600 });
    chmodSync(urlPath, 0o600);
    created.push('the database connection');
  }

  if (created.length === 0) {
    console.log('Secrets are already in place; nothing was changed.');
  } else {
    // Named, never printed. What was created is worth knowing; what it is is not
    // something to put in a log that anything can read.
    console.log(`Created ${created.join(', ')} in ${dir}.`);
    console.log('These live in a volume rather than the database, so a stolen dump cannot read');
    console.log('what they protect — and a dump alone is not a whole restore. Settings → Display');
    console.log('shows the encryption key when you need to copy it somewhere safe.');
  }

  return 0;
}

process.exit(main());
