/**
 * Development seed.
 *
 * Everything here is invented. No real balances, account numbers, institution
 * names or personal details appear in this file, and none ever should — this
 * repository is private today and may be public later, and that has to be a
 * README-and-LICENSE change rather than a data audit.
 *
 * The seed builds a plausible shape rather than a plausible household: enough
 * groupings, envelopes and history to exercise the Budget page, collapse
 * behaviour, negative balances and staleness flags.
 *
 * No users are created. The first account becomes Super Admin through first-run
 * setup, which is where password hashing belongs.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Deliberately not $0.00: the bottom row should show something to look at. */
const CHECKING_CENTS = 4_890_00n;

async function main(): Promise<void> {
  const existing = await prisma.delegation.count();
  if (existing > 0) {
    console.log(`Seed skipped: ${existing} delegation(s) already exist.`);
    return;
  }

  const assetGrouping = await prisma.grouping.create({
    // Assets have exactly one grouping that totals all asset balances.
    data: { name: 'Accounts', section: 'assets' },
  });
  const debtGrouping = await prisma.grouping.create({
    data: { name: 'Cards', section: 'debts' },
  });
  const [essentials, sinking, discretionary] = await Promise.all([
    prisma.grouping.create({ data: { name: 'Essentials', section: 'delegations' } }),
    prisma.grouping.create({ data: { name: 'Sinking Funds', section: 'delegations' } }),
    prisma.grouping.create({ data: { name: 'Discretionary', section: 'delegations' } }),
  ]);

  const checking = await prisma.account.create({
    data: {
      name: 'Everyday Checking',
      type: 'asset',
      source: 'manual',
      balanceCents: CHECKING_CENTS,
      groupingId: assetGrouping.id,
      balanceAsOf: new Date(),
    },
  });

  await prisma.account.create({
    data: {
      name: 'Physical Cash',
      type: 'asset',
      source: 'manual',
      balanceCents: 120_00n,
      groupingId: assetGrouping.id,
      // Cash drifts quietly, so it is worth being reminded about monthly.
      stalenessIntervalDays: 30,
      balanceAsOf: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
    },
  });

  await prisma.account.create({
    data: {
      name: 'Everyday Card',
      type: 'debt',
      source: 'manual',
      balanceCents: 842_15n,
      groupingId: debtGrouping.id,
      balanceAsOf: new Date(),
    },
  });

  // A property and its mortgage: both net-worth-only, which is what keeps a
  // six-figure loan from dominating the budget identity.
  const mortgage = await prisma.account.create({
    data: {
      name: 'Mortgage',
      type: 'debt',
      source: 'manual',
      balanceCents: 310_000_00n,
      inBudget: false,
      inNetWorth: true,
      balanceAsOf: new Date(),
    },
  });
  await prisma.account.create({
    data: {
      name: 'Home',
      type: 'asset',
      source: 'manual',
      balanceCents: 420_000_00n,
      inBudget: false,
      inNetWorth: true,
      mortgageAccountId: mortgage.id,
      stalenessIntervalDays: 180,
      balanceAsOf: new Date(),
    },
  });

  // Notes are freeform on purpose — this is the shape the owner actually writes.
  const delegations = [
    { name: 'Groceries', amountToDelegateCents: 400_00n, groupingId: essentials.id },
    { name: 'Fuel', amountToDelegateCents: 120_00n, groupingId: essentials.id },
    {
      name: 'Electricity',
      amountToDelegateCents: 95_00n,
      groupingId: essentials.id,
      isUtility: true,
      notes: '~$185/mo in winter',
    },
    {
      name: 'Water',
      amountToDelegateCents: 32_00n,
      groupingId: essentials.id,
      isUtility: true,
      notes: 'quarterly, ~$190',
    },
    {
      name: 'Internet',
      amountToDelegateCents: 46_00n,
      groupingId: essentials.id,
      isUtility: true,
    },
    {
      name: 'Car Insurance',
      amountToDelegateCents: 101_54n,
      groupingId: sinking.id,
      notes: '$2200, Dec 27',
    },
    { name: 'Home Maintenance', amountToDelegateCents: 150_00n, groupingId: sinking.id },
    { name: 'Holiday', amountToDelegateCents: 200_00n, groupingId: sinking.id },
    { name: 'Dining Out', amountToDelegateCents: 120_00n, groupingId: discretionary.id },
    // Null, not zero: Delegate adds nothing to this line.
    { name: 'Odds and Ends', amountToDelegateCents: null, groupingId: discretionary.id },
  ];

  for (const delegation of delegations) {
    await prisma.delegation.create({ data: delegation });
  }

  const groceries = await prisma.delegation.findFirstOrThrow({ where: { name: 'Groceries' } });
  const dining = await prisma.delegation.findFirstOrThrow({ where: { name: 'Dining Out' } });

  await prisma.categorizationRule.createMany({
    data: [
      {
        name: 'Supermarket',
        priority: 10,
        matchMode: 'contains',
        matchValue: 'MARKET',
        direction: 'debit',
        delegationId: groceries.id,
      },
      {
        name: 'Coffee shops',
        priority: 20,
        matchMode: 'starts_with',
        matchValue: 'CAFE',
        direction: 'debit',
        delegationId: dining.id,
      },
    ],
  });

  // A single uncategorized transaction, so the Transactions page has something to
  // act on. It is inert: no allocations, so no envelope has moved.
  await prisma.transaction.create({
    data: {
      accountId: checking.id,
      amountCents: -42_17n,
      description: 'Example Market',
      descriptionRaw: 'EXAMPLE MARKET #123',
      postedAt: new Date(),
      source: 'manual',
    },
  });

  const counts = {
    groupings: await prisma.grouping.count(),
    accounts: await prisma.account.count(),
    delegations: await prisma.delegation.count(),
    rules: await prisma.categorizationRule.count(),
    transactions: await prisma.transaction.count(),
  };
  console.log('Seeded:', counts);
  console.log(
    'Every delegation balance is $0 — balances only ever come from ledger events, never from a seeded column.',
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
