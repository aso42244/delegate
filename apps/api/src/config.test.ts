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

/**
 * The zone scheduled jobs are read in.
 *
 * Worth a test because a mistyped zone fails in the quietest way available: an
 * unknown one falls back to the process default, so the job still runs, just
 * never at the hour the operator set — and nothing anywhere would say so.
 */
describe('the schedule timezone', () => {
  it('defaults to UTC, which is what every deployment did before it existed', () => {
    expect(loadConfig({ ...MINIMAL }).SCHEDULE_TIMEZONE).toBe('UTC');
  });

  it('accepts an IANA zone name', () => {
    const config = loadConfig({ ...MINIMAL, SCHEDULE_TIMEZONE: 'America/Chicago' });
    expect(config.SCHEDULE_TIMEZONE).toBe('America/Chicago');
  });

  it('refuses one this runtime does not know', () => {
    expect(() => loadConfig({ ...MINIMAL, SCHEDULE_TIMEZONE: 'America/Sioux_Falls' })).toThrow(
      /IANA time zone/i,
    );
    expect(() => loadConfig({ ...MINIMAL, SCHEDULE_TIMEZONE: 'CST' })).toThrow(/IANA time zone/i);
  });

  it('refuses an offset, which is not a zone and does not observe daylight saving', () => {
    expect(() => loadConfig({ ...MINIMAL, SCHEDULE_TIMEZONE: '-05:00' })).toThrow(
      /IANA time zone/i,
    );
  });
});
