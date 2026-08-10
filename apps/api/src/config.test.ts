import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

/**
 * Configuration validation.
 *
 * Only the rules whose failure is silent rather than loud are worth a test here.
 * A missing `DATABASE_URL` announces itself on the first query; a half-finished
 * TLS configuration does not announce itself at all.
 */

const MINIMAL = {
  DATABASE_URL: 'postgresql://postgres:x@localhost:5432/delegate',
  SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
};

describe('TLS configuration', () => {
  it('accepts neither path, which is plain http and the default', () => {
    const config = loadConfig({ ...MINIMAL });
    expect(config.TLS_CERT_PATH).toBe('');
    expect(config.TLS_KEY_PATH).toBe('');
  });

  it('accepts both paths', () => {
    const config = loadConfig({
      ...MINIMAL,
      TLS_CERT_PATH: '/tls/delegate.crt',
      TLS_KEY_PATH: '/tls/delegate.key',
    });
    expect(config.TLS_CERT_PATH).toBe('/tls/delegate.crt');
  });

  /**
   * The case this test exists for. Half a TLS configuration would otherwise
   * serve plain http from a deployment whose settings say it is encrypted —
   * worse than no TLS, because nobody would look again.
   */
  it('refuses a certificate without its key', () => {
    expect(() => loadConfig({ ...MINIMAL, TLS_CERT_PATH: '/tls/delegate.crt' })).toThrow(
      /both TLS_CERT_PATH and TLS_KEY_PATH/i,
    );
  });

  it('refuses a key without its certificate', () => {
    expect(() => loadConfig({ ...MINIMAL, TLS_KEY_PATH: '/tls/delegate.key' })).toThrow(
      /both TLS_CERT_PATH and TLS_KEY_PATH/i,
    );
  });
});
