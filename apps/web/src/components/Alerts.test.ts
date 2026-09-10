import { describe, expect, it } from 'vitest';
import { byUrgency } from './Alerts.js';

/**
 * The column ends at the loudest thing.
 *
 * Here rather than end to end, and for a reason worth recording: the API reports
 * the worst sync condition rather than every one of them, and it suppresses "not
 * reporting" while a sync is failing outright. Both are right, and between them
 * they make two severities on screen at once impossible to arrange in a fixture.
 */
describe('byUrgency', () => {
  it('puts the quietest first, so the rendered column ends at the loudest', () => {
    const sorted = byUrgency([
      { kind: 'a', severity: 'danger' as const },
      { kind: 'b', severity: 'info' as const },
      { kind: 'c', severity: 'warning' as const },
      { kind: 'd', severity: 'positive' as const },
      { kind: 'e', severity: 'confirm' as const },
    ]);

    expect(sorted.map((row) => row.kind)).toEqual(['d', 'b', 'e', 'c', 'a']);
  });

  it('leaves the order of equally urgent rows alone', () => {
    const sorted = byUrgency([
      { kind: 'first', severity: 'warning' as const },
      { kind: 'second', severity: 'warning' as const },
    ]);

    expect(sorted.map((row) => row.kind)).toEqual(['first', 'second']);
  });

  it('does not modify what it was given', () => {
    const rows = [
      { kind: 'a', severity: 'danger' as const },
      { kind: 'b', severity: 'info' as const },
    ];
    byUrgency(rows);
    expect(rows.map((row) => row.kind)).toEqual(['a', 'b']);
  });
});
