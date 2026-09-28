import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Encrypting a credential at rest.
 *
 * The SimpleFIN access URL is a bearer credential for the household's bank data.
 * Stored in the database it would ride along in every nightly `pg_dump`, and a
 * dump is the thing most likely to leave the NAS — to a shared folder, a
 * cloud-backup target, a laptop. Encrypting it means a stolen backup on its own
 * is useless, because the key never enters the database.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails loudly rather than
 * decrypting to rubbish. A fresh random IV per encryption, stored alongside.
 *
 * The key comes from `config.dataKey`, which is `DATA_ENCRYPTION_KEY` when one
 * is set and `SESSION_SECRET` otherwise. The fallback is what every deployment
 * made before the split does, and it has to stay: the ciphertext already in
 * those databases was written that way.
 *
 * The split exists because one secret doing both jobs meant rotating
 * `SESSION_SECRET` — after a suspected compromise, exactly when you would want
 * to — also made every TOTP secret, the bank credential and every wallet
 * descriptor unreadable in the same moment. That is pressure never to rotate
 * either, which is the opposite of what a secret wants. `npm run secrets:rekey`
 * moves an existing deployment across in one transaction. See ADR 029.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

/**
 * A fixed salt is acceptable here and would not be for passwords. Its job in a
 * password hash is to stop one rainbow table covering every user; there is
 * exactly one key here, derived from a high-entropy secret rather than something
 * memorable, so there is nothing for a precomputed table to attack.
 */
const KEY_SALT = 'household-budget:secret-key:v1';

function deriveKey(key: string): Buffer {
  return scryptSync(key, KEY_SALT, KEY_LENGTH);
}

/** Returns `iv.authTag.ciphertext`, all base64url, safe to store as text. */
export function encryptSecret(plaintext: string, sessionSecret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveKey(sessionSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

export function decryptSecret(stored: string, sessionSecret: string): string {
  const [ivPart, tagPart, cipherPart] = stored.split('.');
  if (!ivPart || !tagPart || !cipherPart) {
    throw new SecretDecryptionError('The stored value is not in the expected format.');
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(sessionSecret),
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(cipherPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Almost always a changed key rather than tampering, and the
    // message says so because that is the actionable case.
    throw new SecretDecryptionError(
      'Could not decrypt the stored credential. If the encryption key changed without `npm run secrets:rekey`, put the previous one back — or reconnect SimpleFIN to store it again.',
    );
  }
}
