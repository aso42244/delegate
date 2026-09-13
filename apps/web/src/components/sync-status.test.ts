import { describe, expect, it } from 'vitest';
import { agoLabel, readSync } from './sync-status.js';
import type { SyncStatus } from '../api/client.js';

/**
 * The boundaries a hand-rolled duration gets wrong.
 *
 * 59 minutes is still minutes; 60 is an hour. 23 hours is still hours; 25 is a
 * day. Each of these is one `<` away from being off by a whole unit, which is
 * the class of mistake nobody notices until a caption says "0h ago".
 */
const NOW = new Date('2026-09-12T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('agoLabel', () => {
  it('says just now under a minute, rather than counting seconds', () => {
    expect(agoLabel(ago(0), NOW)).toBe('just now');
    expect(agoLabel(ago(59_000), NOW)).toBe('just now');
  });

  it('turns over to minutes, hours and days at the right second', () => {
    expect(agoLabel(ago(60_000), NOW)).toBe('1m ago');
    expect(agoLabel(ago(59 * 60_000), NOW)).toBe('59m ago');
    expect(agoLabel(ago(60 * 60_000), NOW)).toBe('1h ago');
    expect(agoLabel(ago(23 * 3_600_000), NOW)).toBe('23h ago');
    expect(agoLabel(ago(24 * 3_600_000), NOW)).toBe('1d ago');
    expect(agoLabel(ago(25 * 3_600_000), NOW)).toBe('1d ago');
    expect(agoLabel(ago(9 * 24 * 3_600_000), NOW)).toBe('9d ago');
  });

  /*
   * The NAS keeps the timestamps and the browser reads them. A clock a few
   * seconds ahead should not produce "-1m ago", which is what subtracting and
   * flooring gives you.
   */
  it('reads a future timestamp as just now rather than a negative duration', () => {
    expect(agoLabel(new Date(NOW.getTime() + 30_000), NOW)).toBe('just now');
  });
});

function status(over: Partial<SyncStatus>): SyncStatus {
  return {
    configured: true,
    credentialSource: 'database',
    connectedAt: '2026-01-01T00:00:00Z',
    credentialProblem: null,
    syncing: false,
    lastSyncAt: null,
    failing: false,
    runs: [],
    ...over,
  };
}

const run = (added: number): SyncStatus['runs'][number] => ({
  id: 'run',
  status: 'succeeded',
  startedAt: '2026-09-12T11:48:00Z',
  finishedAt: '2026-09-12T11:48:30Z',
  accountsTouched: 2,
  transactionsAdded: added,
  transactionsUpdated: 0,
  transactionsReversed: 0,
  error: null,
});

describe('readSync', () => {
  it('says nothing on a fresh install: no run, no credential', () => {
    expect(readSync(status({ configured: false }), NOW)).toBeNull();
    expect(readSync(undefined, NOW)).toBeNull();
  });

  /*
   * The reading is about runs, not about configuration. A run that finished is
   * the thing being reported — and the access URL is encrypted with the
   * deployment's data key, so a gate on `configured` is one no end-to-end test
   * could ever get past.
   */
  it('reports a finished run even where the credential says unconfigured', () => {
    const reading = readSync(
      status({ configured: false, lastSyncAt: '2026-09-12T11:48:00Z', runs: [run(2)] }),
      NOW,
    );
    expect(reading).toEqual({ when: 'Synced 12m ago.', added: '2 new transactions.' });
  });

  it('says a configured feed has never run', () => {
    expect(readSync(status({}), NOW)).toEqual({ when: 'Not synced yet.', added: null });
  });

  it('gives the time and the count the last run brought back', () => {
    const reading = readSync(status({ lastSyncAt: '2026-09-12T11:48:00Z', runs: [run(3)] }), NOW);
    expect(reading).toEqual({ when: 'Synced 12m ago.', added: '3 new transactions.' });
  });

  it('says nothing about a count when the run brought nothing back', () => {
    const reading = readSync(status({ lastSyncAt: '2026-09-12T11:48:00Z', runs: [run(0)] }), NOW);
    expect(reading).toEqual({ when: 'Synced 12m ago.', added: null });
  });

  it('counts one transaction in the singular', () => {
    const reading = readSync(status({ lastSyncAt: '2026-09-12T11:48:00Z', runs: [run(1)] }), NOW);
    expect(reading?.added).toBe('1 new transaction.');
  });
});
