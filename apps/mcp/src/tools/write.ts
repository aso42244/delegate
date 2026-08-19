import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DelegateClient } from '../client.js';
import { money, text } from '../format.js';
import { resolveDelegation } from '../resolve.js';

/**
 * The tools that change something.
 *
 * Registered only when the token actually carries the write scope, so a
 * read-only connection never advertises a tool that would be refused. The
 * server would refuse it anyway — this is about not offering a model a button
 * that does nothing.
 *
 * The boundary itself is not defined here. It is the route allowlist in
 * `plugins/api-token.ts` (ADR 030), and nothing in this file could widen it if
 * it tried: everything below is sorting transactions into envelopes and
 * maintaining the rules that do that automatically. Moving money, archiving,
 * applying a rule across history, and every setting are on the other side of
 * that line, enforced by the server rather than by this file's good intentions.
 *
 * **Every confirmation is built from what the call actually returned, plus what
 * the tool already knew.** The first version of this file assumed the write
 * endpoints echo the row back; they return counts. It reported a failure for
 * work that had in fact landed — which is the worst possible answer here,
 * because the model's reasonable next move is to try again and categorize it
 * twice.
 */

export function registerWriteTools(server: McpServer, client: DelegateClient): void {
  server.registerTool(
    'categorize_transaction',
    {
      title: 'Sort a transaction into an envelope',
      description:
        'Assigns one transaction to a delegation, which takes the money out of that envelope. ' +
        'Use list_transactions with uncategorized set to true to find what is waiting, and take ' +
        'the id from the Id column.\n\n' +
        'Reversible with uncategorize_transaction, but it does move a real balance — so if the ' +
        'right envelope is not obvious from the description, ask rather than guess.',
      inputSchema: {
        transactionId: z.string().uuid().describe('From the Id column of list_transactions.'),
        delegation: z.string().describe('The envelope, by name or id.'),
      },
    },
    async ({ transactionId, delegation }) => {
      const row = await resolveDelegation(client, delegation);
      await client.post<{ allocationCount: number }>(
        `/api/transactions/${transactionId}/categorize`,
        { delegationId: row.id },
      );

      return text(`Sorted that transaction into ${row.name}.`);
    },
  );

  server.registerTool(
    'split_transaction',
    {
      title: 'Split a transaction across envelopes',
      description:
        'Assigns one transaction to several delegations at once, with an explicit amount for ' +
        'each. Amounts are in whole cents as strings and must add up to the transaction, sign ' +
        'included — a $40 purchase split evenly is "-2000" and "-2000". Delegate refuses a set ' +
        'that does not sum exactly, so a split can never quietly lose or invent a cent.',
      inputSchema: {
        transactionId: z.string().uuid(),
        allocations: z
          .array(
            z.object({
              delegation: z.string().describe('The envelope, by name or id.'),
              amountCents: z
                .string()
                .regex(/^-?\d+$/)
                .describe('Whole cents as a string. Negative for money leaving the account.'),
            }),
          )
          .min(2)
          .describe('At least two. They must sum to the transaction amount exactly.'),
      },
    },
    async ({ transactionId, allocations }) => {
      const resolved = await Promise.all(
        allocations.map(async (allocation) => ({
          row: await resolveDelegation(client, allocation.delegation),
          amountCents: allocation.amountCents,
        })),
      );

      await client.post<{ allocationCount: number }>(
        `/api/transactions/${transactionId}/categorize`,
        {
          allocations: resolved.map((entry) => ({
            delegationId: entry.row.id,
            amountCents: entry.amountCents,
          })),
        },
      );

      return text(
        'Split that transaction across ' +
          resolved.map((entry) => `${entry.row.name} ${money(entry.amountCents)}`).join(', ') +
          '.',
      );
    },
  );

  server.registerTool(
    'bulk_categorize_transactions',
    {
      title: 'Sort several transactions into one envelope',
      description:
        'Assigns many transactions to the same delegation in one go — the fast way through a ' +
        'backlog of the same shop appearing twenty times. At most 500 at once.\n\n' +
        'A row that cannot be categorized is reported rather than failing the batch, so check ' +
        'the reply: "sorted 48" out of fifty means two did not go in.',
      inputSchema: {
        transactionIds: z.array(z.string().uuid()).min(1).max(500),
        delegation: z.string().describe('The envelope, by name or id.'),
      },
    },
    async ({ transactionIds, delegation }) => {
      const row = await resolveDelegation(client, delegation);
      const result = await client.post<{
        categorized: number;
        failures: { transactionId: string; reason: string }[];
      }>('/api/transactions/bulk-categorize', {
        transactionIds,
        delegationId: row.id,
      });

      const refused =
        result.failures.length === 0
          ? ''
          : `\n\n${result.failures.length} could not be sorted:\n` +
            result.failures
              .map((failure) => `  ${failure.transactionId} — ${failure.reason}`)
              .join('\n');

      return text(
        `Sorted ${result.categorized} of ${transactionIds.length} transactions into ${row.name}.${refused}`,
      );
    },
  );

  server.registerTool(
    'uncategorize_transaction',
    {
      title: 'Take a transaction back out of its envelope',
      description:
        'Removes the categorization, putting the money back into the envelope and the ' +
        'transaction back into the queue. The way to undo a wrong call.',
      inputSchema: { transactionId: z.string().uuid() },
    },
    async ({ transactionId }) => {
      const result = await client.post<{ reversedEventCount: number }>(
        `/api/transactions/${transactionId}/uncategorize`,
      );

      return text(
        result.reversedEventCount === 0
          ? 'That transaction was not categorized, so nothing changed.'
          : 'That transaction is back in the queue, waiting to be categorized. The money has gone back into its envelope.',
      );
    },
  );

  server.registerTool(
    'create_rule',
    {
      title: 'Create a categorization rule',
      description:
        'Adds a rule that sorts future transactions into an envelope automatically. Rules are ' +
        'tried in priority order and the first match wins.\n\n' +
        'A new rule is inert until it is applied. It catches transactions from the next sync ' +
        'onwards; running it back over history rewrites categorizations made by hand, so that ' +
        'stays a decision the owner makes on the Rules page. Say so rather than implying the ' +
        'backlog has been dealt with.',
      inputSchema: {
        matchMode: z
          .enum(['contains', 'starts_with', 'regex'])
          .describe('How matchValue is compared against the description.'),
        matchValue: z.string().min(1).max(200),
        delegation: z.string().describe('The envelope to sort matches into, by name or id.'),
        name: z.string().max(120).optional().describe('What this rule is for, in a few words.'),
        direction: z
          .enum(['any', 'debit', 'credit'])
          .optional()
          .describe('Limit to money out (debit) or money in (credit). Default any.'),
      },
    },
    async (args) => {
      const row = await resolveDelegation(client, args.delegation);

      // The response carries an id and nothing else, so the confirmation is
      // built from the input that was just accepted.
      await client.post<{ rule: { id: string } }>('/api/rules', {
        matchMode: args.matchMode,
        matchValue: args.matchValue,
        delegationId: row.id,
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.direction === undefined ? {} : { direction: args.direction }),
      });

      const comparison = args.matchMode === 'regex' ? 'matches' : args.matchMode.replace('_', ' ');

      return text(
        `Rule created: anything whose description ${comparison} "${args.matchValue}" goes to ${row.name}.\n\n` +
          'It applies to transactions from the next sync onwards. Existing transactions are ' +
          'untouched — applying a rule across past transactions is done from Settings → Rules, ' +
          'because it can overwrite categorizations made by hand.',
      );
    },
  );
}
