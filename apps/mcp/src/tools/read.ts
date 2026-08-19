import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DelegateClient } from '../client.js';
import { bitcoin, day, money, table, text } from '../format.js';
import { listDelegations, resolveDelegation } from '../resolve.js';
import type {
  AccountDto,
  BudgetDto,
  InsightsDto,
  RuleDto,
  SyncStatusDto,
  TransactionListDto,
} from '../types.js';

/**
 * The tools that only read.
 *
 * Two things shape every description below. A tool description is the only
 * documentation the model gets, so it says what the thing *means* in this
 * budget rather than what endpoint it calls — "envelope", "waiting to be
 * categorized", "reconciles to zero" are the vocabulary the owner uses.
 *
 * And every one of them is bounded. An unbounded `list_transactions` on six
 * months of real data would fill a context window with a bank statement and
 * leave no room for the question that prompted it.
 */

export function registerReadTools(server: McpServer, client: DelegateClient): void {
  server.registerTool(
    'get_budget',
    {
      title: 'Read the budget',
      description:
        'The whole envelope budget as it stands right now: every delegation (an envelope) ' +
        'with its balance and what it is topped up to each payday, the account and debt ' +
        'totals, and the balance reading at the top of the page.\n\n' +
        'That reading is the health check the budget is built around — assets, minus debts, ' +
        'minus what is sitting in envelopes, plus pending charges, should come to about zero. ' +
        'A positive number is money available to delegate rather than a fault.\n\n' +
        'Start here for almost any question about the budget as a whole.',
      inputSchema: {},
    },
    async () => {
      const budget = await client.get<BudgetDto>('/api/budget');
      const { identity } = budget;

      const rows = [
        ...budget.delegations.groupings.flatMap((grouping) =>
          grouping.rows.map((row) => [grouping.name, row] as const),
        ),
        ...budget.delegations.ungrouped.map((row) => ['—', row] as const),
      ];

      const difference = BigInt(identity.differenceCents);
      const reading =
        difference === 0n
          ? 'exactly zero'
          : difference > 0n
            ? `${money(identity.differenceCents)} available to delegate`
            : `${money(identity.differenceCents)} over-delegated — more is spoken for than exists`;

      return text(
        [
          `Balance: ${reading}. Tolerance is ${money(identity.toleranceCents)}.`,
          `  in-budget assets      ${money(identity.assetsCents)}`,
          `  in-budget debts       ${money(identity.debtsCents)}`,
          `  delegated             ${money(identity.delegationsCents)}`,
          `  pending, categorized  ${money(identity.pendingCents)}`,
          '',
          budget.cycleStartedAt === null
            ? 'No pay cycle has been started yet.'
            : `The current pay cycle started ${day(budget.cycleStartedAt)}.`,
          '',
          'Delegations',
          table(
            ['Grouping', 'Delegation', 'Balance', 'Per payday'],
            rows.map(([grouping, row]) => [
              grouping,
              row.isUtility ? `${row.name} (utility)` : row.name,
              money(row.balanceCents),
              money(row.amountToDelegateCents),
            ]),
          ),
          '',
          `Assets total ${money(budget.assets.totalBalanceCents)}, debts total ${money(
            budget.debts.totalBalanceCents,
          )}, delegated total ${money(budget.delegations.totalBalanceCents)}.`,
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'Every account and debt, with its balance and whether it counts towards the budget. ' +
        '"In budget" is what the balance reading is calculated from; an account can be tracked ' +
        'for net worth without being part of the envelope maths. Debts are stored as positive ' +
        'amounts owed.',
      inputSchema: {
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived accounts. Nothing here is ever deleted, only archived.'),
      },
    },
    async ({ includeArchived }) => {
      const { accounts } = await client.get<{ accounts: AccountDto[] }>('/api/accounts', {
        includeArchived: includeArchived === undefined ? undefined : String(includeArchived),
      });

      return text(
        table(
          ['Account', 'Type', 'Balance', 'In budget', 'As of', 'Source'],
          accounts.map((account) => [
            account.nickname ?? account.name,
            account.bitcoinSats === null ? account.type : `${account.type} (bitcoin)`,
            account.bitcoinSats === null
              ? money(account.balanceCents)
              : `${money(account.balanceCents)} · ${bitcoin(account.bitcoinSats)}`,
            account.inBudget ? 'yes' : 'no',
            day(account.balanceAsOf),
            account.archivedAt === null ? account.source : 'archived',
          ]),
        ),
      );
    },
  );

  server.registerTool(
    'list_transactions',
    {
      title: 'List transactions',
      description:
        'Transactions, newest first, with whichever envelope each was sorted into. ' +
        'Filter rather than paging: this is a real household ledger and a bare listing is a ' +
        'bank statement.\n\n' +
        'Set uncategorized to true for the working queue — the transactions waiting for a ' +
        'decision. Transfers between owned accounts and income are excluded from that queue by ' +
        'design, because they are not spending.',
      inputSchema: {
        search: z
          .string()
          .max(200)
          .optional()
          .describe('Matches the description, the account, the envelope, or an amount like 42.10.'),
        delegation: z
          .string()
          .optional()
          .describe('An envelope, by name or id. Returns what was sorted into it.'),
        uncategorized: z
          .boolean()
          .optional()
          .describe('true for only what is waiting; false for only what has been sorted.'),
        pending: z.boolean().optional().describe('true for charges the bank has not settled yet.'),
        dateFrom: z.string().optional().describe('Inclusive, as YYYY-MM-DD.'),
        dateTo: z.string().optional().describe('Inclusive, as YYYY-MM-DD.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50, at most 200.'),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args) => {
      const delegation = args.delegation ? await resolveDelegation(client, args.delegation) : null;

      const result = await client.get<TransactionListDto>('/api/transactions', {
        search: args.search,
        delegationId: delegation?.id,
        uncategorized: args.uncategorized === undefined ? undefined : String(args.uncategorized),
        pending: args.pending === undefined ? undefined : String(args.pending),
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        limit: String(args.limit ?? 50),
        offset: String(args.offset ?? 0),
      });

      const shown = result.offset + result.transactions.length;
      const more =
        shown < result.total
          ? `\n\nShowing ${result.transactions.length} of ${result.total}. Ask for offset ${shown} for the next page.`
          : `\n\n${result.total} in total.`;

      return text(
        table(
          ['Date', 'Description', 'Amount', 'Account', 'Envelope', 'Id'],
          result.transactions.map((transaction) => [
            day(transaction.postedAt),
            transaction.pending ? `${transaction.description} (pending)` : transaction.description,
            money(transaction.amountCents),
            transaction.account.name,
            transaction.allocations.length === 0
              ? '—'
              : transaction.allocations
                  .map((allocation) => allocation.delegation?.name ?? '?')
                  .join(' + '),
            transaction.id,
          ]),
        ) + more,
      );
    },
  );

  server.registerTool(
    'get_spending',
    {
      title: 'Spending over a period',
      description:
        'What was actually spent, grouped by envelope and by grouping, over a window. ' +
        'Also reports anything over-spent (a negative envelope), how much is waiting to be ' +
        'categorized, and income against spending for recent pay cycles.\n\n' +
        'Use this rather than adding up transactions by hand.',
      inputSchema: {
        window: z
          .enum(['30d', '90d', '365d', 'ytd', 'cycle'])
          .optional()
          .describe('Default 30d. "cycle" is since the last payday.'),
      },
    },
    async ({ window }) => {
      const insights = await client.get<InsightsDto>('/api/insights', { window: window ?? '30d' });

      const negative =
        insights.delegations_negative.length === 0
          ? 'Nothing is over-spent.'
          : `Over-spent: ${insights.delegations_negative
              .map((row) => `${row.name} ${money(row.balanceCents)}`)
              .join(', ')}`;

      const backlog =
        insights.uncategorized_backlog.count === 0
          ? 'Nothing is waiting to be categorized.'
          : `${insights.uncategorized_backlog.count} waiting to be categorized, oldest ${day(
              insights.uncategorized_backlog.oldestPostedAt,
            )}.`;

      return text(
        [
          `Spending over ${insights.window}, since ${day(insights.spending_by_delegation.since)}.`,
          '',
          'By envelope',
          table(
            ['Envelope', 'Spent'],
            insights.spending_by_delegation.entries.map((entry) => [
              entry.name,
              money(entry.spendCents),
            ]),
          ),
          '',
          'By grouping',
          table(
            ['Grouping', 'Spent'],
            insights.spending_by_grouping.entries.map((entry) => [
              entry.name,
              money(entry.spendCents),
            ]),
          ),
          '',
          'Recent pay cycles',
          table(
            ['Started', 'Income', 'Spending', 'Surplus'],
            insights.income_vs_spending.map((cycle) => [
              cycle.partial ? `${day(cycle.startedAt)} (partial)` : day(cycle.startedAt),
              money(cycle.incomeCents),
              money(cycle.spendingCents),
              money(cycle.surplusCents),
            ]),
          ),
          '',
          negative,
          backlog,
          `Net worth ${money(insights.asset_debt_composition.netCents)}.`,
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'get_delegation_history',
    {
      title: 'History for one envelope',
      description:
        'Every movement in and out of one envelope, newest first — paydays, spending, ' +
        'transfers and manual adjustments. This is the ledger the balance is computed from, ' +
        'so it answers "where did it go?" exactly.',
      inputSchema: {
        delegation: z.string().describe('The envelope, by name or id.'),
      },
    },
    async ({ delegation }) => {
      const row = await resolveDelegation(client, delegation);
      const { events } = await client.get<{
        events: {
          deltaCents: string;
          eventType: string;
          occurredAt: string;
          reversedAt: string | null;
          actor: { username: string } | null;
        }[];
      }>(`/api/delegations/${row.id}/history`);

      return text(
        `${row.name} — balance ${money(row.balanceCents)}\n\n` +
          table(
            ['Date', 'Change', 'Why', 'By'],
            events.map((event) => [
              day(event.occurredAt),
              money(event.deltaCents),
              event.reversedAt === null ? event.eventType : `${event.eventType} (undone)`,
              event.actor?.username ?? 'automatic',
            ]),
          ),
      );
    },
  );

  server.registerTool(
    'list_rules',
    {
      title: 'List categorization rules',
      description:
        'The rules that sort transactions into envelopes automatically, in the order they are ' +
        'tried. The first one that matches wins.',
      inputSchema: {},
    },
    async () => {
      const [{ rules }, delegations] = await Promise.all([
        client.get<{ rules: RuleDto[] }>('/api/rules'),
        listDelegations(client),
      ]);

      const nameOf = new Map(delegations.map((row) => [row.id, row.name]));

      return text(
        table(
          ['#', 'Name', 'Matches', 'Envelope', 'On?', 'Id'],
          rules.map((rule) => [
            String(rule.priority),
            rule.name ?? '—',
            `${rule.matchMode}: ${rule.matchValue}`,
            nameOf.get(rule.delegationId) ?? rule.delegationId,
            rule.enabled ? 'yes' : 'no',
            rule.id,
          ]),
        ),
      );
    },
  );

  server.registerTool(
    'get_sync_status',
    {
      title: 'Bank sync status',
      description:
        'Whether the bank feed is connected and when it last ran. Worth checking before ' +
        'trusting a balance: the numbers are only as fresh as the last successful sync.',
      inputSchema: {},
    },
    async () => {
      const status = await client.get<SyncStatusDto>('/api/sync/status');

      return text(
        [
          status.configured ? 'The bank feed is connected.' : 'The bank feed is not connected.',
          `Last successful sync: ${day(status.lastSyncAt)}.`,
          status.syncing ? 'A sync is running now.' : '',
          status.failing ? 'The most recent sync failed.' : '',
          status.credentialProblem ?? '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );
}
