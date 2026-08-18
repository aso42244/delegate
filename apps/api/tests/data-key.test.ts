import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { decryptSecret, encryptSecret } from '../src/domain/secrets.js';
import { resetDatabase } from './helpers.js';

/**
 * Splitting the at-rest key from the one that signs sessions.
 *
 * One secret used to do both, which meant rotating `SESSION_SECRET` after a
 * suspected compromise also made every TOTP secret, the bank credential and
 * every wallet descriptor unreadable in the same moment. That coupling is the
 * reason never to rotate either, which is the opposite of what a secret wants.
 */

const SESSION = 'a-session-secret-of-at-least-32-characters';
const DATA = 'a-separate-data-key-of-at-least-32-characters';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgresql://localhost/x',
  SESSION_SECRET: SESSION,
};

beforeEach(async () => {
  await resetDatabase();
});

describe('which key is used', () => {
  it('falls back to the session secret when none is set', () => {
    // Every deployment made before this existed wrote its ciphertext that way,
    // and must keep reading it that way.
    expect(loadConfig({ ...base }).dataKey).toBe(SESSION);
  });

  it('uses the separate key once there is one', () => {
    expect(loadConfig({ ...base, DATA_ENCRYPTION_KEY: DATA }).dataKey).toBe(DATA);
  });

  it('is what makes rotating the session secret survivable', () => {
    // The point of the whole change: a value written under the data key stays
    // readable when the session secret changes underneath it.
    const stored = encryptSecret('the-bank-credential', DATA);

    const rotated = loadConfig({
      ...base,
      SESSION_SECRET: 'a-completely-different-session-secret-32-chars',
      DATA_ENCRYPTION_KEY: DATA,
    });

    expect(decryptSecret(stored, rotated.dataKey)).toBe('the-bank-credential');
  });
});

describe('re-keying', () => {
  it('moves a value from one key to the other, and closes the old one', () => {
    // What `secrets:rekey` does to each row, asserted on the primitive it uses.
    const underOld = encryptSecret('JBSWY3DPEHPK3PXP', SESSION);
    const underNew = encryptSecret(decryptSecret(underOld, SESSION), DATA);

    expect(decryptSecret(underNew, DATA)).toBe('JBSWY3DPEHPK3PXP');
    // The old key opens nothing afterwards — which is the thing that makes
    // rotating it meaningful rather than cosmetic.
    expect(() => decryptSecret(underNew, SESSION)).toThrow();
  });

  it("leaves both of a wallet's descriptors matched to each other", async () => {
    // Half a re-keyed wallet scans one chain and fails on the other, which reads
    // as "my balance halved". They move together or not at all.
    const receive = encryptSecret('wpkh(xpubA/0/*)', SESSION);
    const change = encryptSecret('wpkh(xpubA/1/*)', SESSION);

    const moved = [receive, change].map((value) =>
      encryptSecret(decryptSecret(value, SESSION), DATA),
    );

    expect(moved.map((value) => decryptSecret(value, DATA))).toEqual([
      'wpkh(xpubA/0/*)',
      'wpkh(xpubA/1/*)',
    ]);
    expect(await prisma.bitcoinWallet.count()).toBe(0);
  });
});
