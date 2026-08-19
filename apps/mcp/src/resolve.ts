import type { DelegateClient } from './client.js';
import type { BudgetDto, BudgetRowDto } from './types.js';

/**
 * Turning a name into an id.
 *
 * A model holds the conversation's vocabulary — "groceries", "the car fund" —
 * and never a UUID unless a previous tool call put one in front of it. Making
 * every tool demand an id turns one question into three calls and gives the
 * model three chances to copy a wrong one.
 *
 * So names are accepted everywhere an id is, and resolved here. The rules are
 * deliberately strict about ambiguity: an exact match wins outright, and
 * anything else must be unique. A tool that guesses between "Car" and "Car
 * insurance" would categorize real money into the wrong envelope, and would do
 * it silently.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AmbiguousNameError extends Error {}
export class UnknownNameError extends Error {}

/** Every delegation on the budget, flattened out of its sections. */
export async function listDelegations(client: DelegateClient): Promise<BudgetRowDto[]> {
  const budget = await client.get<BudgetDto>('/api/budget');
  return [
    ...budget.delegations.groupings.flatMap((grouping) => grouping.rows),
    ...budget.delegations.ungrouped,
  ];
}

/**
 * Resolves a delegation reference, which may already be an id.
 *
 * Returns the row rather than the id, because every caller then wants the name
 * to say what it did — "categorized to Groceries" is a confirmation the owner
 * can check, and an id is not.
 */
export async function resolveDelegation(
  client: DelegateClient,
  reference: string,
): Promise<BudgetRowDto> {
  const rows = await listDelegations(client);

  if (UUID.test(reference)) {
    const byId = rows.find((row) => row.id === reference);
    if (byId) return byId;
    throw new UnknownNameError(`No delegation has the id ${reference}.`);
  }

  const wanted = reference.trim().toLowerCase();

  // Exact first, and it wins outright: a budget with both "Car" and "Car
  // insurance" must still be able to name "Car".
  const exact = rows.filter((row) => row.name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new AmbiguousNameError(
      `More than one delegation is called "${reference}". Use its id instead: ${exact
        .map((row) => `${row.name} (${row.id})`)
        .join(', ')}`,
    );
  }

  const partial = rows.filter((row) => row.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0]!;

  if (partial.length > 1) {
    throw new AmbiguousNameError(
      `"${reference}" matches ${partial.length} delegations: ${partial
        .map((row) => row.name)
        .join(', ')}. Say which one.`,
    );
  }

  throw new UnknownNameError(
    `There is no delegation matching "${reference}". The budget has: ${rows
      .map((row) => row.name)
      .join(', ')}`,
  );
}
