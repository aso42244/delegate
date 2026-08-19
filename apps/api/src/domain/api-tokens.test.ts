import { describe, expect, it } from 'vitest';
import { generateApiToken, parseApiToken } from './api-tokens.js';

/**
 * The token format, on its own.
 *
 * Every one of these is here because the format has exactly one job — survive a
 * round trip through a header — and a parser that works on most tokens is
 * indistinguishable from a server that is intermittently broken.
 */

describe('generateApiToken', () => {
  it('produces a token that parses back to its own halves', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const issued = generateApiToken();
      const parsed = parseApiToken(issued.token);

      expect(parsed, issued.token).not.toBeNull();
      expect(parsed!.selector).toBe(issued.selector);
    }
  });

  /**
   * The bug this file was written for. base64url's alphabet includes `_`, so a
   * parser that split on every underscore rejected roughly half of all tokens —
   * and did it at random, which reads as a flaky server rather than as a parser
   * that cannot count.
   */
  it('handles a secret containing the separator', () => {
    const parsed = parseApiToken('dlg_0123456789abcdef_aa_bb-cc_dd');
    expect(parsed).toEqual({ selector: '0123456789abcdef', secret: 'aa_bb-cc_dd' });
  });

  it('never issues the same token twice', () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 500; attempt += 1) seen.add(generateApiToken().token);
    expect(seen.size).toBe(500);
  });

  it('stores a digest that is not the secret', () => {
    const issued = generateApiToken();
    expect(issued.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.token).not.toContain(issued.secretHash);
  });
});

describe('parseApiToken', () => {
  it.each([
    ['empty', ''],
    ['no prefix', '0123456789abcdef_secret'],
    ['wrong prefix', 'ghp_0123456789abcdef_secret'],
    ['selector too short', 'dlg_0123_secret'],
    ['selector not hex', 'dlg_zzzzzzzzzzzzzzzz_secret'],
    ['no secret', 'dlg_0123456789abcdef_'],
    ['a session cookie', 'budget_session=abc123'],
    ['whitespace inside', 'dlg_0123456789abcdef_sec ret'],
  ])('refuses %s', (_label, presented) => {
    expect(parseApiToken(presented)).toBeNull();
  });
});
