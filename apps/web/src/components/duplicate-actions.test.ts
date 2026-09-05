import { describe, expect, it } from 'vitest';
import { duplicateActionAriaLabel, duplicateActionLabels } from './duplicate-actions.js';

/**
 * The defect these exist for: the row text was taught to call a standby pair's
 * sides "from the bank" and "entered by hand", and the buttons underneath were
 * left saying "Archive the later one" and "Archive the first" — a name for a
 * rule that pair is not decided by. The press was correct and the label was
 * about something else.
 */
describe('the archive buttons on a duplicate proposal', () => {
  it('orders a re-import by time, because that is what decides it', () => {
    expect(duplicateActionLabels('reimport')).toEqual({
      archiveCopy: 'Archive the later one',
      archiveOriginal: 'Archive the first',
    });
  });

  it('names a standby pair by source, because both are the same day', () => {
    expect(duplicateActionLabels('standby')).toEqual({
      archiveCopy: 'Archive my copy',
      archiveOriginal: "Archive the bank's",
    });
  });

  it('never says first or later about a standby pair', () => {
    const labels = duplicateActionLabels('standby');
    for (const label of [labels.archiveCopy, labels.archiveOriginal]) {
      expect(label).not.toMatch(/first|later/i);
    }
  });

  it('carries the row into the accessible name, so several proposals stay distinct', () => {
    expect(duplicateActionAriaLabel('standby', 'copy', 'MANUAL - Pirate Ship')).toBe(
      'Archive my copy of MANUAL - Pirate Ship',
    );
    expect(duplicateActionAriaLabel('standby', 'original', 'ACH Payment Pirate Ship')).toBe(
      "Archive the bank's ACH Payment Pirate Ship",
    );
    expect(duplicateActionAriaLabel('reimport', 'copy', 'WHOLEFDS MKT')).toBe(
      'Archive the later WHOLEFDS MKT',
    );
  });
});
