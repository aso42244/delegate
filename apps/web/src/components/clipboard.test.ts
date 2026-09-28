import { describe, expect, it } from 'vitest';
import { groupSecret } from './clipboard.js';

/**
 * The pure half of the clipboard helper. `copyText` needs a real browser and a
 * real origin to mean anything — a stubbed `navigator` would only prove the
 * stub — so it is covered end to end, on both the secure and the plain-http
 * path.
 */
describe('grouping an authenticator secret', () => {
  it('spaces a base32 secret in fours', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });

  it('leaves a short trailing group short rather than padding it', () => {
    expect(groupSecret('JBSWY3DPEH')).toBe('JBSW Y3DP EH');
  });

  it('handles the empty case without producing a stray space', () => {
    expect(groupSecret('')).toBe('');
  });

  /**
   * The grouping is for the eye only. Whatever this returns, the value handed to
   * the clipboard is the original — a password manager given "ABCD EFGH" may
   * keep the space, and a second factor that produces codes matching nothing is
   * found out at the worst possible moment.
   */
  it('is reversible by removing spaces, so the displayed and copied values agree', () => {
    const secret = 'KRSXG5CTMVRXEZLUGE2TSMJSGM2TSMJS';
    expect(groupSecret(secret).replaceAll(' ', '')).toBe(secret);
  });
});
