import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The nightly database dump.
 *
 * Shelling out to `pg_dump` rather than reimplementing it: a dump produced by
 * the tool that ships with PostgreSQL is one `pg_restore` reads without
 * argument, and this is the code path that has to work on the worst day this
 * household has.
 *
 * §14 places backups in Phase 1 rather than Phase 3, because data loss during
 * the move off the spreadsheet would be unrecoverable.
 */

const execFileAsync = promisify(execFile);

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

function scriptPath(name: string): string {
  return fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url));
}

/**
 * Runs the dump and returns where it landed.
 *
 * Failures raise rather than resolving quietly: a backup that fails silently is
 * worse than none at all, because it is trusted.
 */
export async function runBackup(env: NodeJS.ProcessEnv = process.env): Promise<BackupResult> {
  const script = scriptPath('backup.sh');
  if (!existsSync(script)) {
    throw new BackupError(`The backup script is missing from the image at ${script}`);
  }

  try {
    const { stdout } = await execFileAsync('sh', [script], {
      env,
      // Generous, because a first dump of a year of transactions on a Celeron is
      // not fast, and a timeout here would leave a `.partial` file behind.
      timeout: 15 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });

    const match = /^(\S+) \((\d+) bytes\)$/m.exec(stdout.trim());
    if (!match?.[1] || !match[2]) {
      throw new BackupError(`Could not read the backup script's output: ${stdout.trim()}`);
    }

    return { path: match[1], bytes: Number(match[2]) };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new BackupError(`pg_dump failed: ${detail}`);
  }
}
