import { randomUUID } from 'node:crypto';

/**
 * Generates a batch id.
 *
 * `randomUUID` is a cryptographically secure v4 UUID, generated in-process. An
 * earlier version asked PostgreSQL for `gen_random_uuid()` instead, which cost a
 * network round trip inside the transaction that Delegate, Transfer and
 * Reconcile each hold open — for a value the database was never the authority on.
 */
export function newUuid(): string {
  return randomUUID();
}
