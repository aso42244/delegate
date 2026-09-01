import type { Db } from '../db/client.js';
import { decryptSecret } from './secrets.js';

/**
 * Proves at boot that the key in force can still read what is stored.
 *
 * This exists because of a specific, recoverable, and extremely alarming
 * failure that the documented re-key procedure could produce:
 *
 * 1. `secrets:rekey` moves every stored secret onto `DATA_ENCRYPTION_KEY_NEW`.
 * 2. That value goes into `.env` as `DATA_ENCRYPTION_KEY`, as instructed.
 * 3. Compose reads `.env` only to *substitute into the compose file*. Unless a
 *    line in the `environment:` block names the variable, it never reaches the
 *    container — and for a while there was no such line.
 * 4. The application restarts still deriving its key from `SESSION_SECRET`, and
 *    now nothing decrypts.
 *
 * What that looks like from outside is the worst part. `verifySecondFactor`
 * decrypts the TOTP secret *before* it considers recovery codes, so it throws
 * first: every account is locked out, recovery codes included, and the symptom
 * is "two-factor stopped working for everybody at once" with no hint of why.
 *
 * A key that cannot read the database is not a state to discover at a sign-in
 * screen. Boot is the moment to find it, while somebody is still watching a
 * terminal — so this reads one secret of each kind and refuses to start if it
 * cannot, naming the likely cause.
 *
 * Refusing to start is the harsher-looking option and the better one: the
 * alternative is a process that answers `/health` perfectly while nobody can
 * sign in, which is this project's oldest lesson in a new costume.
 */

export class DataKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataKeyError';
  }
}

/** One stored ciphertext of each kind, or nothing where none exists yet. */
async function samples(db: Db): Promise<{ what: string; ciphertext: string }[]> {
  const found: { what: string; ciphertext: string }[] = [];

  const user = await db.user.findFirst({
    where: { totpSecretEncrypted: { not: null } },
    select: { username: true, totpSecretEncrypted: true },
  });
  if (user?.totpSecretEncrypted) {
    found.push({
      what: `the second factor for ${user.username}`,
      ciphertext: user.totpSecretEncrypted,
    });
  }

  const settings = await db.budgetSettings.findUnique({
    where: { id: 1 },
    select: { simplefinAccessUrlEncrypted: true },
  });
  if (settings?.simplefinAccessUrlEncrypted) {
    found.push({
      what: 'the SimpleFIN credential',
      ciphertext: settings.simplefinAccessUrlEncrypted,
    });
  }

  const wallet = await db.bitcoinWallet.findFirst({
    select: { label: true, receiveDescriptorEncrypted: true },
  });
  if (wallet) {
    found.push({ what: `wallet ${wallet.label}`, ciphertext: wallet.receiveDescriptorEncrypted });
  }

  return found;
}

/**
 * Throws `DataKeyError` when the key in force cannot read a stored secret.
 *
 * A fresh install has nothing encrypted yet and passes trivially, which is
 * correct: there is no key to be wrong about until something is stored.
 */
export async function assertDataKeyReadsStoredSecrets(
  db: Db,
  dataKey: string,
  dataKeyIsExplicit: boolean,
): Promise<void> {
  for (const sample of await samples(db)) {
    try {
      decryptSecret(sample.ciphertext, dataKey);
    } catch {
      throw new DataKeyError(
        [
          `Cannot decrypt ${sample.what} with the key in force.`,
          '',
          dataKeyIsExplicit
            ? 'DATA_ENCRYPTION_KEY is set. It does not match what the stored secrets were encrypted with — check it is the same value `secrets:rekey` was run with.'
            : 'DATA_ENCRYPTION_KEY is NOT set, so the key is derived from SESSION_SECRET. If `secrets:rekey` has been run, the value it moved to has to reach this container — setting it in `.env` is not enough on its own unless docker-compose.yml passes it through.',
          '',
          'Nothing has been changed. Starting with the wrong key would lock every account out of sign-in, recovery codes included.',
        ].join('\n'),
      );
    }
  }
}
