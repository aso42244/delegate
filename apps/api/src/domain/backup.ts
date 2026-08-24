import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

export interface BackupFile {
  readonly name: string;
  readonly bytes: number;
  readonly writtenAt: Date;
  /** A dump is only complete when its checksum sidecar is beside it. */
  readonly hasChecksum: boolean;
}

/**
 * What is actually in the backup directory.
 *
 * The health of a backup is *"has a dump landed recently"*, never *"did the last
 * attempt throw"*. Those differ in the case that matters: the nightly dump on
 * this deployment failed every night for weeks with a permission error, was
 * logged at error level each time, and nothing anywhere read the log. The
 * application stayed green because nothing had asked the only question worth
 * asking.
 *
 * Reads the directory rather than a table, because the directory is the truth.
 * A row saying a backup succeeded is a second thing that can be right while the
 * file is missing.
 */
export async function listBackups(directory: string): Promise<BackupFile[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // Missing or unreadable is not an error to throw: it is the answer, and the
    // caller reports "no backups" rather than a stack trace.
    return [];
  }

  const dumps = entries.filter((name) => name.startsWith('delegate-') && name.endsWith('.dump'));
  const checksums = new Set(entries.filter((name) => name.endsWith('.sha256')));

  const files: BackupFile[] = [];
  for (const name of dumps) {
    try {
      const info = await stat(join(directory, name));
      files.push({
        name,
        bytes: info.size,
        writtenAt: info.mtime,
        hasChecksum: checksums.has(`${name}.sha256`),
      });
    } catch {
      // Deleted between the listing and the stat — by retention, most likely.
      continue;
    }
  }

  return files.sort((a, b) => b.writtenAt.getTime() - a.writtenAt.getTime());
}

/**
 * When a complete dump last landed, or null if one never has.
 *
 * Only a dump carrying its checksum counts. `backup.sh` writes to a `.partial`
 * name and renames both files on success, so a dump without its sidecar is the
 * wreckage of a failed run and must not read as a backup.
 */
export async function newestBackupAt(directory: string): Promise<Date | null> {
  const complete = (await listBackups(directory)).filter((file) => file.hasChecksum);
  return complete[0]?.writtenAt ?? null;
}
