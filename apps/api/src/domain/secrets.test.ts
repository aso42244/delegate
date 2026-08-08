import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, SecretDecryptionError } from './secrets.js';

/**
 * Encryption of a stored credential.
 *
 * The threat this addresses is a leaked database dump — the nightly `pg_dump` is
 * the copy most likely to leave the NAS. These assert the ciphertext is useless
 * without the key, and that tampering fails loudly rather than silently.
 */

const SECRET = 'a-session-secret-of-at-least-32-characters';
const ACCESS_URL = 'https://user:s3cr3t@bridge.example.test/simplefin';

describe('encrypting a secret', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret(ACCESS_URL, SECRET), SECRET)).toBe(ACCESS_URL);
  });

  it('never leaves the plaintext visible in the stored value', () => {
    const stored = encryptSecret(ACCESS_URL, SECRET);

    // The whole point: a dump containing this row reveals nothing.
    expect(stored).not.toContain('s3cr3t');
    expect(stored).not.toContain('bridge.example.test');
  });

  it('produces a different ciphertext every time', () => {
    // A fresh IV per encryption, so identical inputs are not recognisably equal.
    expect(encryptSecret(ACCESS_URL, SECRET)).not.toBe(encryptSecret(ACCESS_URL, SECRET));
  });

  it('refuses to decrypt with a different key', () => {
    const stored = encryptSecret(ACCESS_URL, SECRET);

    expect(() => decryptSecret(stored, 'a-different-secret-of-32-characters-x')).toThrow(
      SecretDecryptionError,
    );
  });

  it('explains that rotating SESSION_SECRET is the likely cause', () => {
    const stored = encryptSecret(ACCESS_URL, SECRET);

    // The actionable case, so the message names it rather than saying "failed".
    expect(() => decryptSecret(stored, 'another-secret-of-thirty-two-chars-yz')).toThrow(
      /SESSION_SECRET/,
    );
  });

  it('rejects a tampered ciphertext rather than returning rubbish', () => {
    const stored = encryptSecret(ACCESS_URL, SECRET);
    const [iv, tag, ciphertext] = stored.split('.');
    const flipped = `${ciphertext!.slice(0, -2)}${ciphertext!.endsWith('A') ? 'B' : 'A'}=`;

    // GCM authenticates, so this is detected rather than decrypting to garbage.
    expect(() => decryptSecret(`${iv!}.${tag!}.${flipped}`, SECRET)).toThrow(SecretDecryptionError);
  });

  it('rejects a value that is not in the expected format', () => {
    expect(() => decryptSecret('not-encrypted-at-all', SECRET)).toThrow(SecretDecryptionError);
  });
});
