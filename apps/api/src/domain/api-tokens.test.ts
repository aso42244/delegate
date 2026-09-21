import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { API_TOKEN_PREFIX, bearerFrom, digestOf, digestsMatch, newSecret } from './api-tokens.js';

/**
 * The three things a second copy of a credential always gets wrong: entropy,
 * what is stored, and how two digests are compared. Pure, so they run on every
 * commit without a database.
 */

describe('a new secret', () => {
  it('carries the prefix, so a leaked one says what it is', () => {
    expect(newSecret().startsWith(API_TOKEN_PREFIX)).toBe(true);
  });

  it('is 32 random bytes, which is long enough that guessing is not a strategy', () => {
    const body = newSecret().slice(API_TOKEN_PREFIX.length);
    // base64url of 32 bytes is 43 characters, no padding.
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is never the same twice', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newSecret()));
    expect(seen.size).toBe(50);
  });
});

describe('the digest', () => {
  it('is SHA-256 of the secret, hex — a fast digest, not a password hash', () => {
    const secret = `${API_TOKEN_PREFIX}example`;
    expect(digestOf(secret)).toBe(createHash('sha256').update(secret).digest('hex'));
  });

  it('never equals the secret it was made from', () => {
    const secret = newSecret();
    expect(digestOf(secret)).not.toBe(secret);
    expect(digestOf(secret)).not.toContain(secret.slice(API_TOKEN_PREFIX.length));
  });
});

describe('comparing digests', () => {
  it('accepts equal ones and refuses different ones', () => {
    const a = digestOf('one');
    expect(digestsMatch(a, digestOf('one'))).toBe(true);
    expect(digestsMatch(a, digestOf('two'))).toBe(false);
  });

  it('refuses a different length without throwing, which timingSafeEqual would', () => {
    expect(digestsMatch(digestOf('one'), 'short')).toBe(false);
    expect(digestsMatch('', digestOf('one'))).toBe(false);
  });
});

describe('the Authorization header', () => {
  it('yields the token from a Bearer header, whatever the case of the scheme', () => {
    expect(bearerFrom('Bearer dlg_abc')).toBe('dlg_abc');
    expect(bearerFrom('bearer dlg_abc')).toBe('dlg_abc');
    expect(bearerFrom('  Bearer   dlg_abc  ')).toBe('dlg_abc');
  });

  it('yields nothing for no header, another scheme, or a malformed value', () => {
    expect(bearerFrom(undefined)).toBeUndefined();
    expect(bearerFrom('')).toBeUndefined();
    expect(bearerFrom('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(bearerFrom('Bearer')).toBeUndefined();
    expect(bearerFrom('Bearer two words')).toBeUndefined();
    expect(bearerFrom('dlg_abc')).toBeUndefined();
  });
});
