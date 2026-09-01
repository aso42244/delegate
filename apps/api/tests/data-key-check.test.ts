import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { assertDataKeyReadsStoredSecrets, DataKeyError } from '../src/domain/data-key-check.js';
import { encryptSecret } from '../src/domain/secrets.js';
import { resetDatabase } from './helpers.js';

/**
 * The boot check, and the failure it exists to catch.
 *
 * The re-key procedure had a hole in it: compose reads `.env` to substitute into
 * the compose file and does not hand it to the container, so setting
 * `DATA_ENCRYPTION_KEY` there did nothing unless a line named it. Following the
 * documented steps therefore moved every secret onto a key the application was
 * not using.
 *
 * The symptom is what makes this worth a boot check rather than a comment. The
 * second factor is decrypted *before* recovery codes are considered, so a wrong
 * key locks out every account including the way back in — and says only that
 * two-factor stopped working.
 */

const RIGHT = 'the-key-everything-was-encrypted-with-32';
const WRONG = 'a-different-key-entirely-also-32-chars-ok';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeUserWithSecret(key: string): Promise<void> {
  await prisma.user.create({
    data: {
      username: 'owner',
      passwordHash: 'test-only-not-a-hash',
      role: 'super_admin',
      totpSecretEncrypted: encryptSecret('JBSWY3DPEHPK3PXP', key),
      totpConfirmedAt: new Date(),
    },
  });
}

describe('the key in force', () => {
  it('passes when it can read what is stored', async () => {
    await makeUserWithSecret(RIGHT);

    await expect(assertDataKeyReadsStoredSecrets(prisma, RIGHT, true)).resolves.toBeUndefined();
  });

  it('refuses when it cannot', async () => {
    await makeUserWithSecret(RIGHT);

    await expect(assertDataKeyReadsStoredSecrets(prisma, WRONG, true)).rejects.toBeInstanceOf(
      DataKeyError,
    );
  });

  /**
   * The two cases need different advice, because the fix is different: one is a
   * wrong value, the other is a value that never arrived.
   */
  it('names the compose passthrough when no explicit key is set', async () => {
    await makeUserWithSecret(RIGHT);

    await expect(assertDataKeyReadsStoredSecrets(prisma, WRONG, false)).rejects.toThrow(
      /docker-compose\.yml passes it through/,
    );
  });

  it('names the value itself when one is set', async () => {
    await makeUserWithSecret(RIGHT);

    await expect(assertDataKeyReadsStoredSecrets(prisma, WRONG, true)).rejects.toThrow(
      /same value `secrets:rekey` was run with/,
    );
  });

  it('passes trivially on a fresh install, where nothing is encrypted yet', async () => {
    await expect(assertDataKeyReadsStoredSecrets(prisma, WRONG, false)).resolves.toBeUndefined();
  });

  /** A secret stored by another route must be checked too, not only the first. */
  it('checks the SimpleFIN credential as well as a second factor', async () => {
    await prisma.budgetSettings.update({
      where: { id: 1 },
      data: { simplefinAccessUrlEncrypted: encryptSecret('https://u:p@bridge.test/x', RIGHT) },
    });

    await expect(assertDataKeyReadsStoredSecrets(prisma, WRONG, true)).rejects.toThrow(
      /SimpleFIN credential/,
    );
  });
});
