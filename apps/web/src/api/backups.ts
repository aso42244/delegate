import { api } from './client.js';

/** What is actually in the backup directory, read from disk on every request. */

export interface BackupFileDto {
  readonly name: string;
  readonly bytes: number;
  readonly writtenAt: string;
  /** A dump is only complete when its checksum sidecar is beside it. */
  readonly hasChecksum: boolean;
}

export interface BackupStatusDto {
  readonly directory: string;
  /** The same directory as the host names it, or null when nothing said. */
  readonly hostDirectory: string | null;
  /** The schedule as configured, so the card can describe this deployment. */
  readonly cron: string;
  /** The IANA zone the expression above is read in. */
  readonly timezone: string;
  readonly retentionDays: number;
  readonly count: number;
  readonly newestAt: string | null;
  readonly recent: readonly BackupFileDto[];
}

export const backupsApi = {
  status: () => api.get<BackupStatusDto>('/api/backups'),
};
