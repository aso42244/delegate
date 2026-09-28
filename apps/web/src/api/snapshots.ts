import { api } from './client.js';

/**
 * Whether the nightly snapshot actually ran.
 *
 * The endpoint has existed since the job did, and until now nothing called it.
 * That is the failure it was written to prevent, happening to it: the backup
 * reported every failure correctly into a log nobody read, and the fix was to
 * ask whether the evidence is on disk — which only helps if something asks.
 */
export interface SnapshotStatusDto {
  /** The newest day recorded, as a date key. Null when none ever has been. */
  readonly latestDate: string | null;
  readonly latestProvenance: string | null;
  /** How many days are stored. Insights draws from these and nothing else. */
  readonly days: number;
  /**
   * True once the newest is more than two days old. Two rather than one because
   * a run is always for the *previous* day, so the newest date is a day behind
   * even when everything is working.
   */
  readonly stale: boolean;
  readonly cron: string;
  readonly timezone: string;
}

export const snapshotsApi = {
  status: () => api.get<SnapshotStatusDto>('/api/snapshots/status'),
};
