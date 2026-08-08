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
 * The key is derived from `SESSION_SECRET` with scrypt. That avoids a second
 * mandatory environment variable at the cost of one real consequence, documented
 * in the README: **rotating `SESSION_SECRET` makes the stored value
 * undecryptable**, and SimpleFIN has to be reconnected. That is a paste-a-token
 * recovery, not a data loss, and rotation is rare.
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

function deriveKey(sessionSecret: string): Buffer {
  return scryptSync(sessionSecret, KEY_SALT, KEY_LENGTH);
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
    // Almost always a rotated SESSION_SECRET rather than tampering, and the
    // message says so because that is the actionable case.
    throw new SecretDecryptionError(
      'Could not decrypt the stored credential. If SESSION_SECRET was changed, reconnect SimpleFIN to store it again.',
    );
  }
}
