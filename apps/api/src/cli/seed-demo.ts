/**
 * The demo household.
 *
 * Everything here is invented and always has been: no real balance, account
 * number, institution or person appears in this file, and none ever should.
 * That is the whole point of the demo — it exists so the application can be
 * shown without showing anybody's money.
 *
 * ## What makes it convincing
 *
 * Not the numbers. A budget looks real when the *shapes* are right: income that
 * lands on a cadence, bills that recur and drift, a grocery bill that varies by
 * the week, utilities that follow the seasons, a mortgage that amortises, and a
 * Delegate run at the start of every pay cycle. Those are what the charts draw.
 *
 * ## How it stays current
 *
 * Dates are computed backwards from **today**, every run. There is no fixed
 * calendar in here, so a demo shown in March and the same demo shown in July are
 * both up to date, and the outflow band always has a partial month at the top.
 *
 * ## How the history is built
 *
 * The state is built through the domain's own functions — `createManualTransaction`,
 * `categorizeTransaction`, `runDelegate` — so the ledger, the cached balances
 * and the events agree by construction rather than because this file did the
 * arithmetic correctly. They stamp *now*, so a second pass backdates the rows
 * they wrote. Backdating a timestamp cannot disturb a balance, because every
 * balance here is a sum over events rather than a function of their dates.
 *
 * The nightly snapshots the history charts read are **reconstructed**, not
 * invented: one snapshot is written at the start of the window and `fillGaps`
 * rebuilds every day since from the ledger — the same code that repairs a real
 * household's missed nights. So the demo exercises that path rather than
 * side-stepping it.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createManualTransaction } from '../domain/transactions.js';
import { categorizeTransaction } from '../domain/allocations.js';
import { runDelegate } from '../domain/delegate.js';
import { captureSnapshot } from '../domain/snapshots.js';
import { fillGaps } from '../domain/snapshot-fill.js';
import { hashPassword } from '../domain/passwords.js';

const prisma = new PrismaClient();

/** How much history. Eighteen months: enough for a year-on-year utility trend. */
const MONTHS = 18;

/** The household is paid every other Friday. */
const CYCLE_DAYS = 14;

const TIME_ZONE = process.env['SCHEDULE_TIMEZONE'] ?? 'America/Chicago';

/**
 * Deterministic randomness.
 *
 * A demo that reshuffles itself every night is one where a figure somebody
 * pointed at yesterday is gone today. Seeded, so the same day produces the same
 * household — and the variance still looks like variance.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = rng(20_260_909);

/** A whole number of cents, jittered by a fraction either way. */
function about(cents: number, spread: number): bigint {
  const factor = 1 + (random() * 2 - 1) * spread;
  return BigInt(Math.round((cents * factor) / 100) * 100);
}

/** Midday, so no rounding of a date can move a transaction across a boundary. */
function daysAgo(days: number): Date {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  at.setDate(at.getDate() - days);
  return at;
}

/**
 * A month's share of a seasonal bill.
 *
 * Electricity peaks in summer and gas in winter, which is what makes a utility
 * chart look like a utility chart rather than a flat line with noise on it.
 */
function seasonal(date: Date, peakMonth: number, depth: number): number {
  const turns = ((date.getMonth() - peakMonth) / 12) * 2 * Math.PI;
  return 1 + Math.cos(turns) * depth;
}

/**
 * The household's shape.
 *
 * Named for what they are rather than for anybody: a family with a mortgage, two
 * cars, a few subscriptions and a grocery bill. Recognisable to anybody being
 * shown this, and belonging to nobody.
 */
const GROUPINGS = ['Home', 'Food', 'Vehicles', 'Health', 'Family', 'Giving'] as const;
type Grouping = (typeof GROUPINGS)[number];

interface Line {
  readonly name: string;
  readonly grouping: Grouping;
  readonly utility?: boolean;
}

/**
 * How much of a buffer each line is funded with, over what it actually costs.
 *
 * Not zero, because a household that funds every line at exactly its average
 * ends the year with every line at zero and nothing to look at. Not much either:
 * the interesting thing about an envelope budget is the lines that *drift* —
 * a bill that came in high, a sinking fund filling up — and a generous buffer
 * flattens all of it into a slow climb.
 */
const BUFFER = 0.04;

const LINES: readonly Line[] = [
  { name: 'Mortgage', grouping: 'Home' },
  { name: 'Electricity', grouping: 'Home', utility: true },
  { name: 'Natural Gas', grouping: 'Home', utility: true },
  { name: 'Water & Sewer', grouping: 'Home', utility: true },
  { name: 'Home Maintenance', grouping: 'Home' },
  { name: 'Groceries', grouping: 'Food', utility: true },
  { name: 'Dining Out', grouping: 'Food' },
  { name: 'Gasoline', grouping: 'Vehicles', utility: true },
  { name: 'Car Insurance', grouping: 'Vehicles' },
  { name: 'Vehicle Maintenance', grouping: 'Vehicles' },
  { name: 'Medical', grouping: 'Health' },
  { name: 'Pharmacy', grouping: 'Health' },
  { name: 'Subscriptions', grouping: 'Family' },
  { name: 'Kids Activities', grouping: 'Family' },
  { name: 'Household Money', grouping: 'Family' },
  { name: 'Giving', grouping: 'Giving' },
];

/**
 * What actually gets charged, and how often.
 *
 * `everyCycle` bills land once a pay cycle; `monthly` ones land on a day of the
 * month, which is what a mortgage and a utility do. The merchant names are
 * invented and deliberately look like a bank feed — uppercase, a店 number, a
 * city — because that is what the register has to be legible against.
 */
interface Charge {
  readonly line: string;
  readonly merchant: string;
  readonly cents: number;
  readonly spread: number;
  readonly cadence: 'monthly' | 'weekly' | 'cycle';
  readonly dayOfMonth?: number;
  /** Month of peak, for the bills that follow the seasons. */
  readonly peakMonth?: number;
  readonly depth?: number;
}

const CHARGES: readonly Charge[] = [
  {
    line: 'Mortgage',
    merchant: 'MIDWEST HOME LOANS PMT',
    cents: 185_000,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 1,
  },
  {
    line: 'Electricity',
    merchant: 'PRAIRIE POWER & LIGHT',
    cents: 14_500,
    spread: 0.08,
    cadence: 'monthly',
    dayOfMonth: 12,
    peakMonth: 7,
    depth: 0.45,
  },
  {
    line: 'Natural Gas',
    merchant: 'NORTHERN GAS UTILITY',
    cents: 9_500,
    spread: 0.1,
    cadence: 'monthly',
    dayOfMonth: 15,
    peakMonth: 0,
    depth: 0.7,
  },
  {
    line: 'Water & Sewer',
    merchant: 'CITY WATER AND SEWER',
    cents: 8_900,
    spread: 0.06,
    cadence: 'monthly',
    dayOfMonth: 18,
  },
  {
    line: 'Car Insurance',
    merchant: 'HERITAGE MUTUAL INS',
    cents: 19_200,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 22,
  },
  {
    line: 'Subscriptions',
    merchant: 'STREAMBOX MONTHLY',
    cents: 1_899,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 9,
  },
  {
    line: 'Subscriptions',
    merchant: 'CLOUDSTORE ANNUAL PLAN',
    cents: 3_499,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 24,
  },
  {
    line: 'Giving',
    merchant: 'RIVERSIDE CHURCH GIVING',
    cents: 48_000,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 3,
  },
  {
    line: 'Groceries',
    merchant: 'HY-MART #1418 CEDARVILLE',
    cents: 14_200,
    spread: 0.35,
    cadence: 'weekly',
  },
  {
    line: 'Groceries',
    merchant: 'CORNER MARKET CEDARVILLE',
    cents: 4_100,
    spread: 0.4,
    cadence: 'weekly',
  },
  { line: 'Gasoline', merchant: 'QUICKFUEL #221', cents: 5_600, spread: 0.25, cadence: 'weekly' },
  {
    line: 'Dining Out',
    merchant: 'THE BLUE SPOON CAFE',
    cents: 4_800,
    spread: 0.4,
    cadence: 'weekly',
  },
  {
    line: 'Pharmacy',
    merchant: 'CEDARVILLE PHARMACY',
    cents: 2_600,
    spread: 0.5,
    cadence: 'cycle',
  },
  {
    line: 'Kids Activities',
    merchant: 'CEDARVILLE PARKS & REC',
    cents: 8_500,
    spread: 0.2,
    cadence: 'cycle',
  },
  {
    line: 'Household Money',
    merchant: 'GENERAL STORE CEDARVILLE',
    cents: 3_900,
    spread: 0.45,
    cadence: 'cycle',
  },
  {
    line: 'Medical',
    merchant: 'CEDARVILLE FAMILY CLINIC',
    cents: 9_500,
    spread: 0.6,
    cadence: 'monthly',
    dayOfMonth: 20,
  },
  {
    line: 'Home Maintenance',
    merchant: 'BUILDERS SUPPLY CO',
    cents: 11_500,
    spread: 0.7,
    cadence: 'monthly',
    dayOfMonth: 26,
  },
  {
    line: 'Vehicle Maintenance',
    merchant: 'CEDARVILLE AUTO SERVICE',
    cents: 14_000,
    spread: 0.6,
    cadence: 'monthly',
    dayOfMonth: 14,
  },
];

/**
 * What one Delegate press puts into a line: what it costs, plus the buffer.
 *
 * **Derived from the charges rather than chosen.** Hand-picking sixteen amounts
 * produced a household whose every line climbed for eighteen months, because
 * each guess was comfortably over what that line actually spent — and a budget
 * where nothing is ever tight is a budget with nothing to show. Sizing the
 * delegation to the spending makes the balances hover, which is what puts a
 * line into the red occasionally and gives the pace bars something to say.
 */
function perCycleFor(line: string): number {
  const yearly = CHARGES.filter((charge) => charge.line === line).reduce((total, charge) => {
    const times = charge.cadence === 'monthly' ? 12 : charge.cadence === 'weekly' ? 52 : 26;
    return total + charge.cents * times;
  }, 0);
  // To the nearest dollar, because a household picks round numbers.
  return Math.round(((yearly / CYCLES_PER_YEAR) * (1 + BUFFER)) / 100) * 100;
}

/** Twenty-six pay days a year, which is what "every other Friday" means. */
const CYCLES_PER_YEAR = 26;

/** Take-home, every other Friday, with the occasional bit of overtime. */
const PAY_CENTS = 271_500;

/**
 * Every pay day in the window, oldest first.
 *
 * Anchored to the most recent one rather than to a fixed date, so the newest
 * cycle is always the one in progress and the demo opens partway through it —
 * which is what makes the pace bars and the tick worth looking at.
 */
function payDays(): Date[] {
  const days: Date[] = [];
  // Five days into the current cycle: far enough that the ticks have moved,
  // early enough that nothing looks spent.
  for (let back = 5; back <= MONTHS * 31; back += CYCLE_DAYS) days.push(daysAgo(back));
  return days.reverse();
}

/** Every date in the window on which a monthly charge with this day-of-month falls. */
function monthlyDates(dayOfMonth: number, from: Date, to: Date): Date[] {
  const dates: Date[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), dayOfMonth, 12, 0, 0, 0);
  while (cursor <= to) {
    if (cursor >= from) dates.push(new Date(cursor.getTime()));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return dates;
}

/** Every seventh day in the window, offset so the weeks do not all start together. */
function weeklyDates(offset: number, from: Date, to: Date): Date[] {
  const dates: Date[] = [];
  const cursor = new Date(from.getTime());
  cursor.setDate(cursor.getDate() + offset);
  while (cursor <= to) {
    dates.push(new Date(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 7);
  }
  return dates;
}

interface Planned {
  readonly at: Date;
  readonly description: string;
  readonly cents: bigint;
  readonly line: string | null;
  readonly kind: 'normal' | 'income';
}

/**
 * Everything that happens, as a flat dated list.
 *
 * Built before anything is written so it can be sorted: the ledger has to be
 * applied in order, because a balance is a running sum and a categorization out
 * of sequence is a balance that was briefly wrong.
 */
function plan(from: Date, to: Date): Planned[] {
  const planned: Planned[] = [];

  // Pay, every other Friday, with the occasional bit of overtime.
  for (const at of payDays()) {
    planned.push({
      at,
      description: 'CEDARVILLE SCHOOLS PAYROLL',
      cents: about(PAY_CENTS, random() < 0.15 ? 0.08 : 0.01),
      line: null,
      kind: 'income',
    });
  }

  for (const [index, charge] of CHARGES.entries()) {
    const dates =
      charge.cadence === 'monthly'
        ? monthlyDates(charge.dayOfMonth ?? 1, from, to)
        : charge.cadence === 'weekly'
          ? weeklyDates(index % 7, from, to)
          : payDays().map((day) => {
              const at = new Date(day.getTime());
              at.setDate(at.getDate() + 3);
              return at;
            });

    for (const at of dates) {
      if (at > to) continue;
      // A season where the bill has one, so a utility chart looks like a
      // utility chart rather than a flat line with noise on it.
      const season =
        charge.peakMonth === undefined ? 1 : seasonal(at, charge.peakMonth, charge.depth ?? 0.3);
      planned.push({
        at,
        description: charge.merchant,
        cents: -about(Math.round(charge.cents * season), charge.spread),
        line: charge.line,
        kind: 'normal',
      });
    }
  }

  return planned.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Refuses to run anywhere that is not a demo.
 *
 * This wipes every table it touches. Pointed at a household's real database it
 * would destroy the thing the application exists to protect, and "I was in the
 * wrong shell" is not a defence anybody gets to use twice — so the check is on
 * the configuration the demo container sets and nothing else.
 */
function refuseUnlessDemo(): void {
  if (process.env['DELEGATE_DEMO'] !== 'true') {
    throw new Error(
      'demo-seed refuses to run: DELEGATE_DEMO is not "true".\n' +
        'This wipes the database it is pointed at. It is for a demo instance only.',
    );
  }
}

/** The demo is disposable and rebuilt every night, so it starts from nothing. */
async function wipe(): Promise<void> {
  /*
   * Children before parents, all the way down.
   *
   * The snapshots come first and it is not obvious why: they hold a foreign key
   * to every delegation and account they recorded, so deleting the delegations
   * first fails on a constraint from a table nothing else in this file mentions.
   */
  await prisma.$transaction([
    prisma.delegationSnapshot.deleteMany(),
    prisma.accountSnapshot.deleteMany(),
    prisma.aggregateSnapshot.deleteMany(),
    prisma.delegationEvent.deleteMany(),
    prisma.transactionAllocation.deleteMany(),
    prisma.transaction.deleteMany(),
    prisma.delegateRun.deleteMany(),
    prisma.delegation.deleteMany(),
    prisma.account.deleteMany(),
    prisma.grouping.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

async function main(): Promise<void> {
  refuseUnlessDemo();
  await wipe();

  const to = daysAgo(0);
  const from = daysAgo(MONTHS * 31);

  // ---- the shape of the household ----------------------------------------
  const assets = await prisma.grouping.create({ data: { name: 'Accounts', section: 'assets' } });
  const debts = await prisma.grouping.create({ data: { name: 'Cards', section: 'debts' } });

  const groupings = new Map<Grouping, string>();
  for (const [position, name] of GROUPINGS.entries()) {
    const row = await prisma.grouping.create({
      data: { name, section: 'delegations', position },
    });
    groupings.set(name, row.id);
  }

  /*
   * Somebody for the demo to be.
   *
   * A demo instance signs its visitor in without a session, and this is who it
   * signs them in as. The role is `user`, the least of the three: an Admin can
   * manage accounts and reach Settings, and a demo has nothing there worth
   * showing and a token in it worth not showing.
   *
   * The password hash is a real one for a password nobody is told, because
   * nothing on a demo asks for it — the column simply cannot be null, and a
   * recognisable placeholder in it would be a worse answer than a hash of
   * something random.
   */
  await prisma.user.create({
    data: {
      username: 'demo@delegate.example',
      displayName: 'Demo Household',
      passwordHash: await hashPassword(randomUUID()),
      role: 'user',
      // Nothing to enrol: the sign-in this would gate does not happen here.
      totpConfirmedAt: to,
    },
  });

  const checking = await prisma.account.create({
    data: {
      name: 'Everyday Checking',
      type: 'asset',
      source: 'manual',
      balanceCents: 0n,
      groupingId: assets.id,
      balanceAsOf: to,
    },
  });
  await prisma.account.create({
    data: {
      name: 'Everyday Card',
      type: 'debt',
      source: 'manual',
      balanceCents: 61_240n,
      groupingId: debts.id,
      balanceAsOf: to,
    },
  });

  // A property and its mortgage, both net-worth-only: that is what keeps a
  // six-figure loan from dominating the budget identity.
  const mortgage = await prisma.account.create({
    data: {
      name: 'Mortgage',
      type: 'debt',
      source: 'manual',
      balanceCents: 268_400_00n,
      inBudget: false,
      inNetWorth: true,
      balanceAsOf: to,
    },
  });
  await prisma.account.create({
    data: {
      name: 'Home',
      type: 'asset',
      source: 'manual',
      balanceCents: 389_000_00n,
      inBudget: false,
      inNetWorth: true,
      mortgageAccountId: mortgage.id,
      stalenessIntervalDays: 180,
      balanceAsOf: to,
    },
  });

  /*
   * The next payday, so the cycle is real.
   *
   * Without an anchor there is no dated cycle: no tick on any pace bar, no
   * "day 5 of 14", and three tiles that say they need one. Those are among the
   * better things to show, and a demo that opens with them switched off is a
   * demo that has to be apologised for.
   *
   * A fortnight after the last one, which is where the household's next pay
   * actually lands.
   */
  const nextPayday = new Date(payDays()[payDays().length - 1]!.getTime());
  nextPayday.setDate(nextPayday.getDate() + CYCLE_DAYS);
  await prisma.budgetSettings.updateMany({
    data: { payCadence: 'biweekly', nextPaydayOn: nextPayday },
  });

  const lines = new Map<string, string>();
  for (const [position, line] of LINES.entries()) {
    const row = await prisma.delegation.create({
      data: {
        name: line.name,
        groupingId: groupings.get(line.grouping)!,
        amountToDelegateCents: BigInt(perCycleFor(line.name)),
        balanceCents: 0n,
        isUtility: line.utility ?? false,
        position,
      },
      select: { id: true },
    });
    lines.set(line.name, row.id);
  }

  await buildHistory({ checkingId: checking.id, lines, from, to });
  await arrangeOverview(lines);
}

/**
 * The arrangement the demo opens on, and the lines its panel watches.
 *
 * Stored rather than left to the default, for two reasons. The panel's chosen
 * delegations live in a layout row, so a demo without one opens with "No
 * delegations chosen yet." beside the thing it is meant to be showing. And the
 * demo is read-only: nobody looking at it can arrange anything, so whatever it
 * opens with is what it has.
 *
 * `overviewArranged` goes with it. Without that the read falls back to the
 * default and this is ignored — which is the distinction that exists so a
 * household who cleared their page keeps it cleared.
 */
async function arrangeOverview(lines: Map<string, string>): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ select: { id: true } });
  await prisma.user.update({ where: { id: user.id }, data: { overviewArranged: true } });

  /** Enough to fill the panel and show the groupings, not so many it scrolls. */
  const watched = [
    'Groceries',
    'Dining Out',
    'Gasoline',
    'Electricity',
    'Natural Gas',
    'Kids Activities',
    'Household Money',
    'Medical',
  ]
    .map((name) => lines.get(name))
    .filter((id): id is string => id !== undefined);

  const layout: [string, 'main' | 'sidebar', number, number][] = [
    ['spending_by_grouping', 'main', 0, 0],
    ['spending_by_delegation', 'main', 0, 1],
    ['allocation', 'main', 0, 2],
    ['cashflow', 'main', 1, 0],
    ['upcoming_bills', 'main', 2, 0],
    ['bills_this_cycle', 'main', 2, 1],
    ['utilities_trend', 'main', 2, 2],
    ['net_worth_over_time', 'main', 3, 0],
    ['delegations', 'main', 4, 0],
    ['daily_outflow', 'sidebar', 0, 0],
    ['delegations_negative', 'sidebar', 1, 0],
    ['uncategorized_backlog', 'sidebar', 2, 0],
  ];

  for (const [widgetKey, region, row, position] of layout) {
    await prisma.overviewTile.create({
      data: {
        userId: user.id,
        widgetKey,
        region,
        row,
        position,
        ...(widgetKey === 'delegations' ? { config: { delegationIds: watched } } : {}),
      },
    });
  }
}

/**
 * Walks the window, cycle by cycle, applying everything in date order.
 *
 * A Delegate run on every pay day and the charges in between, through the
 * domain's own functions — so the ledger, the cached balances and the events
 * agree because the application produced them, not because this file did the
 * arithmetic right.
 *
 * They stamp *now*, which is the one thing they cannot be asked not to do. So
 * every row gets its real date afterwards, in one pass. Backdating cannot
 * disturb a balance: every balance here is a sum over events, and a sum does not
 * care when its terms were written.
 */
async function buildHistory(options: {
  readonly checkingId: string;
  readonly lines: Map<string, string>;
  readonly from: Date;
  readonly to: Date;
}): Promise<void> {
  const { checkingId, lines, from, to } = options;
  const planned = plan(from, to);

  /** What to backdate, and to when: the domain hands back ids, not dates. */
  const datedTransactions: { id: string; at: Date }[] = [];
  const datedRuns: { id: string; at: Date }[] = [];

  /*
   * A run on every pay day but the last.
   *
   * The most recent pay packet is left sitting undelegated on purpose, because
   * that is the most useful state to open a demo in: money has arrived, nothing
   * has been distributed, and Delegate — the one action this whole application
   * is named for — has something to do. Delegating it here would leave the
   * button greyed out and the demo would have to be explained rather than shown.
   */
  const days = payDays();
  let cursor = 0;
  for (const [index, payday] of days.entries()) {
    // Everything that happened before this pay day, in order.
    while (cursor < planned.length && planned[cursor]!.at < payday) {
      await apply(planned[cursor]!);
      cursor += 1;
    }

    if (index === days.length - 1) continue;

    const run = await runDelegate(prisma, { actorId: null });
    datedRuns.push({ id: run.runId, at: payday });
  }

  // Whatever is left after the last pay day: the cycle in progress.
  while (cursor < planned.length) {
    await apply(planned[cursor]!);
    cursor += 1;
  }

  await backdate();
  await settleChecking(checkingId, days[days.length - 1] ?? from);
  await buildSnapshots(from, to);

  async function apply(entry: Planned): Promise<void> {
    const created = await createManualTransaction(prisma, {
      accountId: checkingId,
      amountCents: entry.cents,
      description: entry.description,
      postedAt: entry.at,
      kind: entry.kind,
    });
    datedTransactions.push({ id: created.id, at: entry.at });

    /*
     * A handful are left uncategorized on purpose — the newest few, which is
     * exactly what a household that has not sat down this week looks like. The
     * backlog tile is one of the more interesting things on the page and an
     * empty one says nothing.
     */
    const recent = entry.at.getTime() > to.getTime() - 4 * 24 * 60 * 60 * 1000;
    if (entry.line === null || (recent && random() < 0.6)) return;

    await categorizeTransaction(prisma, created.id, lines.get(entry.line)!, { actorId: null });
  }

  /**
   * Every row gets the date it should have had.
   *
   * Raw SQL rather than the domain, because this is the one thing the domain
   * deliberately will not let anybody do: a transaction's `postedAt` is set by
   * whoever created it, and `created_at` on an event is the ledger's own record
   * of when it happened. Both are correct rules, and both have to be stepped
   * around exactly once, here, to build a past that never happened.
   */
  async function backdate(): Promise<void> {
    for (const { id, at } of datedRuns) {
      await prisma.$executeRaw`UPDATE delegate_runs SET created_at = ${at} WHERE id = ${id}::uuid`;
      await prisma.$executeRaw`
        UPDATE delegation_events SET created_at = ${at} WHERE delegate_run_id = ${id}::uuid`;
    }

    // An event follows the transaction it came from, so a categorization is
    // dated by its charge rather than by when this script happened to run it.
    for (const { id, at } of datedTransactions) {
      await prisma.$executeRaw`
        UPDATE delegation_events SET created_at = ${at} WHERE transaction_id = ${id}::uuid`;
      await prisma.$executeRaw`
        UPDATE transactions SET created_at = ${at} WHERE id = ${id}::uuid`;
    }

    /*
     * Every row came through `createManualTransaction`, which stamps `manual` —
     * correctly, because that is what it is for. But the cashflow chart names
     * its income nodes by source, so a demo built this way shows every penny
     * arriving as "Income (manual)": the label that exists to mark the rows
     * somebody typed in while the bank feed was down.
     *
     * A demo household has a bank feed like anybody else.
     */
    await prisma.$executeRaw`UPDATE transactions SET source = 'simplefin'`;
  }
}

/**
 * The checking balance, from what actually went through it.
 *
 * Derived rather than declared, because the budget identity compares the
 * accounts against the delegations and a figure invented here would show the
 * demo permanently out of balance — a red number on the first screen anybody is
 * shown, explaining itself as a fault in the application rather than in the
 * seed.
 */
async function settleChecking(checkingId: string, lastRun: Date): Promise<void> {
  const delegated = await prisma.delegation.aggregate({
    where: { archivedAt: null },
    _sum: { balanceCents: true },
  });

  /*
   * Set to whatever makes the identity hold today.
   *
   * The household's envelopes hold what they hold, and the accounts in the
   * budget have to come to the same — that is what the identity *means*. So the
   * checking balance is the delegations, plus whatever the card owes, because
   * the identity nets the debts off and the card's balance is money already
   * spent from an envelope but not yet paid.
   *
   * Getting this wrong put a red figure on the first screen anybody is shown,
   * explaining itself as a fault in the application rather than in the seed.
   */
  const cards = await prisma.account.aggregate({
    where: { inBudget: true, type: 'debt', archivedAt: null },
    _sum: { balanceCents: true },
  });

  /*
   * Plus the pay that has not been delegated yet, which is the whole point of
   * opening the demo in that state: the difference between the accounts and the
   * envelopes is exactly what Delegate is waiting to distribute, and the Budget
   * page names it.
   */
  const waiting = await prisma.transaction.aggregate({
    where: { accountId: checkingId, kind: 'income', archivedAt: null, postedAt: { gte: lastRun } },
    _sum: { amountCents: true },
  });

  await prisma.account.update({
    where: { id: checkingId },
    data: {
      balanceCents:
        (delegated._sum.balanceCents ?? 0n) +
        (cards._sum.balanceCents ?? 0n) +
        (waiting._sum.amountCents ?? 0n),
      balanceAsOf: daysAgo(0),
    },
  });
}

/**
 * The nightly history the charts read.
 *
 * One snapshot at the start of the window, then `fillGaps` rebuilds every day
 * since from the ledger — the same code that repairs a real household's missed
 * nights, so the demo exercises that path rather than side-stepping it.
 *
 * `missingDates` is capped at 370 days a pass, deliberately: a longer gap is a
 * clock that moved rather than an outage. Eighteen months is two passes, and
 * looping until it stops finding gaps is the honest way to ask for more without
 * arguing with the cap.
 */
async function buildSnapshots(from: Date, to: Date): Promise<void> {
  await captureSnapshot(prisma, from);

  for (let pass = 0; pass < 3; pass += 1) {
    const result = await fillGaps(prisma, to, TIME_ZONE);
    if (result.filled === 0) break;
  }
}

await main()
  .then(() => {
    console.log('Demo household built.');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
