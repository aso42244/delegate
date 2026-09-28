import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The secrets bootstrap, run as the container runs it.
 *
 * Driven through the built CLI rather than by importing it, because the module
 * calls `process.exit` at import time — and because what is under test is what
 * the compose file actually invokes. A one-shot container that writes the wrong
 * thing is not a bug anybody sees until every account is locked out.
 *
 * The assertion that matters most is the upgrade one. A deployment that predates
 * ADR 029 has every stored secret encrypted with a key derived from
 * `SESSION_SECRET`; if this generated a fresh at-rest key for it, nothing would
 * decrypt and the upgrade would look like a catastrophe.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegate-secrets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the CLI the way the compose service does, with a chosen environment.
 *
 * Deliberately **not** `{ ...process.env }`. A developer's shell has `.env`
 * sourced into it, so inheriting it meant every "fresh install" case ran with a
 * real `SESSION_SECRET` present and quietly tested the upgrade path instead —
 * which is exactly the case that hid a bug here until this was fixed. A
 * container inherits nothing; neither does this.
 */
function run(environment: Record<string, string> = {}): string {
  return execFileSync('node', ['apps/api/dist/cli/init-secrets.js'], {
    env: { PATH: process.env['PATH'] ?? '', SECRETS_DIR: dir, ...environment },
    encoding: 'utf8',
  });
}

function read(file: string): string {
  return readFileSync(join(dir, file), 'utf8').trim();
}

describe('a fresh install', () => {
  it('generates everything, so nothing has to be configured', () => {
    run();

    for (const file of ['session-secret', 'data-key', 'postgres-password', 'database-url']) {
      expect(read(file), file).not.toBe('');
    }

    // Long enough for the configuration's own minimum, which refuses anything
    // under 32 characters.
    expect(read('session-secret').length).toBeGreaterThanOrEqual(32);
  });

  it('gives the at-rest key a life of its own', () => {
    run();

    // The whole of ADR 029: rotating the session secret must not make every
    // stored secret unreadable, which it does while they are the same value.
    expect(read('data-key')).not.toBe(read('session-secret'));
  });

  it('builds a connection string the generated password survives', () => {
    run();

    const url = read('database-url');
    // A base64 password contains `+` and `/`, both of which mean something else
    // inside a URL. Parsing it back is the proof it was encoded.
    expect(() => new URL(url)).not.toThrow();
    expect(decodeURIComponent(new URL(url).password)).toBe(read('postgres-password'));
  });

  it('writes secrets only the owner can read', () => {
    run();

    expect(statSync(join(dir, 'data-key')).mode & 0o777).toBe(0o600);
  });
});

describe('an existing deployment', () => {
  it('adopts the secrets already in .env rather than replacing them', () => {
    run({
      SESSION_SECRET: 'the-existing-session-secret-32-chars',
      POSTGRES_PASSWORD: 'existing-db',
    });

    expect(read('session-secret')).toBe('the-existing-session-secret-32-chars');
    expect(read('postgres-password')).toBe('existing-db');
  });

  /**
   * The one that would break a live budget.
   *
   * Before ADR 029 the at-rest key was derived from `SESSION_SECRET`. A fresh
   * random key here cannot read a single stored TOTP secret, so every account
   * would be locked out on upgrade — including by recovery code, because the
   * second factor is decrypted before recovery codes are considered.
   */
  it('inherits the at-rest key from the session secret, so nothing needs re-encrypting', () => {
    run({ SESSION_SECRET: 'the-existing-session-secret-32-chars' });

    expect(read('data-key')).toBe('the-existing-session-secret-32-chars');
  });

  it('prefers an explicit at-rest key over the session secret', () => {
    run({
      SESSION_SECRET: 'the-existing-session-secret-32-chars',
      DATA_ENCRYPTION_KEY: 'a-separate-key-already-in-use-here-ok',
    });

    expect(read('data-key')).toBe('a-separate-key-already-in-use-here-ok');
  });
});

describe('running again', () => {
  /**
   * Every restart runs this. Regenerating anything would make every stored
   * secret unreadable and lock the household out, so "never overwrite" is the
   * rule the whole file is built around.
   */
  it('changes nothing at all', () => {
    run();
    const before = ['session-secret', 'data-key', 'postgres-password', 'database-url'].map(read);

    // Even when the environment now disagrees with what is on disk.
    const output = run({ SESSION_SECRET: 'a-completely-different-secret-value-32' });

    const after = ['session-secret', 'data-key', 'postgres-password', 'database-url'].map(read);
    expect(after).toEqual(before);
    expect(output).toContain('already in place');
  });
});

describe('what it says out loud', () => {
  it('names what it created and never prints it', () => {
    const output = run();

    expect(output).toContain('Created');
    for (const file of ['session-secret', 'data-key', 'postgres-password']) {
      expect(output).not.toContain(read(file));
    }
  });
});

describe('the database connection', () => {
  it('follows the least-privilege role when one is configured', () => {
    run({ APP_DB_USER: 'delegate_app', POSTGRES_DB: 'delegate' });

    const url = new URL(read('database-url'));
    expect(url.username).toBe('delegate_app');
    expect(url.pathname).toBe('/delegate');
  });

  it('falls back to the superuser when none is', () => {
    run({ POSTGRES_USER: 'postgres' });

    expect(new URL(read('database-url')).username).toBe('postgres');
  });
});

describe('a partially written directory', () => {
  /** An interrupted first run must not leave a secret that reads as empty. */
  it('replaces an empty file rather than adopting it', () => {
    writeFileSync(join(dir, 'session-secret'), '\n');

    run();

    expect(read('session-secret')).not.toBe('');
  });
});
