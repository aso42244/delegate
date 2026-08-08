import type { Db } from '../db/client.js';
import { claimSetupToken } from '../simplefin/client.js';
import { ConflictError } from './errors.js';
import { decryptSecret, encryptSecret, SecretDecryptionError } from './secrets.js';

/**
 * Where the SimpleFIN access URL lives.
 *
 * §7 specifies the environment. That still works and takes nothing away, but it
 * makes reconnecting a job for whoever can edit a file on the NAS — exactly the
 * moment the owner is least likely to want an SSH session. So a URL claimed
 * through Settings is stored in the database instead, encrypted, and takes
 * precedence.
 *
 * The credential itself never leaves the server: no route returns it, and the
 * status endpoint reports only where it came from.
 */

export type CredentialSource = 'database' | 'environment' | 'none';

export interface SimpleFinConnection {
  readonly accessUrl: string | null;
  readonly source: CredentialSource;
  readonly connectedAt: Date | null;
  /** Set when a stored value exists but cannot be decrypted — see below. */
  readonly problem: string | null;
}

async function readSettings(
  db: Db,
): Promise<{ simplefinAccessUrlEncrypted: string | null; simplefinConnectedAt: Date | null }> {
  const settings = await db.budgetSettings.findUnique({
    where: { id: 1 },
    select: { simplefinAccessUrlEncrypted: true, simplefinConnectedAt: true },
  });
  return settings ?? { simplefinAccessUrlEncrypted: null, simplefinConnectedAt: null };
}

/**
 * Resolves the credential: database first, environment second.
 *
 * A stored value that will not decrypt is reported rather than silently falling
 * back. Falling through to a stale environment variable would sync the wrong
 * connection and look like it worked.
 */
export async function resolveConnection(
  db: Db,
  environmentUrl: string,
  sessionSecret: string,
): Promise<SimpleFinConnection> {
  const settings = await readSettings(db);

  if (settings.simplefinAccessUrlEncrypted) {
    try {
      return {
        accessUrl: decryptSecret(settings.simplefinAccessUrlEncrypted, sessionSecret),
        source: 'database',
        connectedAt: settings.simplefinConnectedAt,
        problem: null,
      };
    } catch (error) {
      return {
        accessUrl: null,
        source: 'database',
        connectedAt: settings.simplefinConnectedAt,
        problem:
          error instanceof SecretDecryptionError
            ? error.message
            : 'The stored SimpleFIN credential could not be read.',
      };
    }
  }

  if (environmentUrl) {
    return {
      accessUrl: environmentUrl,
      source: 'environment',
      connectedAt: null,
      problem: null,
    };
  }

  return { accessUrl: null, source: 'none', connectedAt: null, problem: null };
}

/**
 * Claims a setup token and stores the resulting access URL encrypted.
 *
 * A token can be claimed exactly once, so a failure here means the owner needs a
 * fresh one — the error from the client says so directly.
 */
export async function connectWithSetupToken(
  db: Db,
  setupToken: string,
  sessionSecret: string,
  now: Date = new Date(),
): Promise<{ connectedAt: Date }> {
  const accessUrl = await claimSetupToken(setupToken);

  await db.budgetSettings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      simplefinAccessUrlEncrypted: encryptSecret(accessUrl, sessionSecret),
      simplefinConnectedAt: now,
    },
    update: {
      simplefinAccessUrlEncrypted: encryptSecret(accessUrl, sessionSecret),
      simplefinConnectedAt: now,
    },
  });

  return { connectedAt: now };
}

/**
 * Stores an access URL the owner already holds, for the case where a token was
 * claimed elsewhere — through the CLI, or on a previous deployment.
 */
export async function connectWithAccessUrl(
  db: Db,
  accessUrl: string,
  sessionSecret: string,
  now: Date = new Date(),
): Promise<{ connectedAt: Date }> {
  const trimmed = accessUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ConflictError(
      'invalid_access_url',
      'That does not look like a SimpleFIN access URL. It should start with https:// and contain credentials.',
    );
  }

  await db.budgetSettings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      simplefinAccessUrlEncrypted: encryptSecret(trimmed, sessionSecret),
      simplefinConnectedAt: now,
    },
    update: {
      simplefinAccessUrlEncrypted: encryptSecret(trimmed, sessionSecret),
      simplefinConnectedAt: now,
    },
  });

  return { connectedAt: now };
}

/**
 * Forgets the stored credential. The environment variable, if set, becomes the
 * source again — which is why the status endpoint always reports the source
 * rather than a bare connected/disconnected boolean.
 */
export async function disconnect(db: Db): Promise<void> {
  await db.budgetSettings.upsert({
    where: { id: 1 },
    create: { id: 1, simplefinAccessUrlEncrypted: null, simplefinConnectedAt: null },
    update: { simplefinAccessUrlEncrypted: null, simplefinConnectedAt: null },
  });
}
