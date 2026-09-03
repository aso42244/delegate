import { merchantKey, type Cents } from '@budget/shared';
import { localDayKey } from './calendar.js';
import type { Db } from '../db/client.js';
import { ValidationError } from './errors.js';

/**
 * Bills that arrive on a schedule, worked out from the register itself.
 *
 * Nothing here is entered by anybody and nothing is stored. A bill is a merchant
 * whose charges have landed at a steady interval, and both facts — that it
 * recurs, and when the next one is due — are already in the transactions. Asking
 * the household to maintain a second list of the same thing would produce a list
 * that is wrong within a month.
 *
 * The question it answers is the one nothing else here can: **the bill that did
 * not arrive.** A failed autopay and a cancelled service look identical from the
 * inside — no transaction — and are invisible until a balance is wrong or a
 * letter arrives. A subscription that renewed at a higher price is the same
 * shape: perfectly ordinary, and unremarkable until the two figures sit beside
 * each other.
 *
 * It proposes and never writes, which is the line [ADR 030] drew for a cleared
 * check and [ADR 044] for a suggested delegation. This is a reading of the data,
 * recomputed every time it is asked for, and it stops existing the moment it
 * stops being true.
 *
 * **One thing is stored: what a person says back.** The first real run listed a
 * thrift shop visited every fortnight as a fortnightly bill, and no threshold
 * would have known better — the spending genuinely has the shape of a bill, and
 * only the household knows it is a shop. So a bill can be taken off the list or
 * given a name of its own, and those corrections live in `bill_overrides`,
 * keyed by merchant. Still no bills stored; only the answers to them.
 */

/**
 * How many charges before a merchant is a bill.
 *
 * Three, because two give one interval and one interval cannot be checked
 * against anything. Three give two intervals that must agree.
 */
const MIN_OCCURRENCES = 3;

/**
 * The shortest gap that can be a bill.
 *
 * Twelve days, which is the honest edge of what this can claim. Groceries,
 * coffee and fuel recur in the plain sense — the same shop, over and over — and
 * their gaps are erratic enough that a tolerant consistency check would happily
 * call a weekly shop a weekly bill. A household's actual bills are fortnightly
 * at the fastest, so the cheapest way to be right is to decline to answer below
 * that rather than to answer confidently and wrongly.
 */
const MIN_INTERVAL_DAYS = 12;

/** Longer than this and there is not enough history to have seen it three times. */
const MAX_INTERVAL_DAYS = 400;

/**
 * How far back the register is read. As for suggestions: this runs whenever the
 * page is opened, and a household's register grows for ever.
 */
const HISTORY_LIMIT = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Names the shape of the interval, for a reader rather than for arithmetic.
 *
 * "Every two weeks" rather than "fortnightly", which the rest of this
 * application does not say — Settings → Budget offers "Every two weeks — 26 a
 * year" for the pay cadence, and one vocabulary for one idea is the whole reason
 * the chip and copy rules exist.
 */
const CADENCES = [
  { label: 'Every two weeks', min: 12, max: 17 },
  { label: 'Every three weeks', min: 18, max: 24 },
  { label: 'Monthly', min: 25, max: 38 },
  { label: 'Every two months', min: 50, max: 70 },
  { label: 'Quarterly', min: 80, max: 100 },
  { label: 'Twice a year', min: 170, max: 200 },
  { label: 'Yearly', min: 340, max: 400 },
] as const;

/**
 * What a bill is doing right now.
 *
 * `lapsed` exists so that a cancelled service does not read as overdue for ever.
 * A bill nobody can act on that shouts anyway is the shape that teaches people
 * to stop reading the thing that shouts.
 *
 * `arrived` exists because of a worse version of the same failure. A life
 * insurance payment left the account and sat in the register while its bill read
 * **Overdue · 5d** — the charge was pending, and pending charges are excluded
 * from this detection on purpose, because their date moves when they settle.
 * Excluding them from the *arithmetic* is right. Excluding them from the
 * question "has this arrived?" was not, and it made the page say something the
 * register plainly contradicted.
 */
export type BillStatus = 'expected' | 'arrived' | 'due' | 'overdue' | 'lapsed';

export interface RecurringBill {
  /** The merchant key. Stable across store numbers, and the row's identity. */
  readonly key: string;
  /** The name to show: the household's own where they gave one, the feed's otherwise. */
  readonly name: string;
  /** What the bank calls it, always. Shown where the two differ, so a rename hides nothing. */
  readonly feedName: string;
  /** True when the name above is the household's rather than the bank's. */
  readonly renamed: boolean;
  readonly cadence: string;
  readonly intervalDays: number;
  readonly occurrences: number;
  /** The middle charge, which a bill that varies seasonally still has. */
  readonly typicalAmountCents: Cents;
  /** The most recent one. Beside the typical figure, a price rise is visible. */
  readonly lastAmountCents: Cents;
  readonly lastPostedAt: Date;
  readonly expectedNextAt: Date;
  readonly status: BillStatus;
  /** How many days late, for an overdue bill. Zero otherwise. */
  readonly daysLate: number;
  /**
   * The charge that answered for this period but has not settled.
   *
   * Set on an `arrived` bill and null otherwise. It is what makes the status
   * legible rather than mysterious: the row can say the money has gone and is
   * still pending, instead of quietly not being overdue any more.
   */
  readonly pendingSince: Date | null;
  /** How many charges were attached by hand, so the row can offer to undo it. */
  readonly linkedCount: number;
  /** Where charges from this merchant are usually filed, if they are. */
  readonly delegationId: string | null;
  readonly delegationName: string | null;
  readonly accountName: string | null;
}

/** The middle value. Even counts take the lower of the two, which needs no averaging. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function medianCents(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0n;
}

/**
 * How far an interval may sit from the middle one and still be the same bill.
 *
 * A quarter of the interval, floored at four days. Month lengths differ by
 * three, a bill that falls on a weekend moves by two, and a card that posts a
 * day late moves by one — all of that is the same monthly bill and none of it is
 * a different schedule.
 */
function toleranceDays(intervalDays: number): number {
  return Math.max(4, Math.round(intervalDays * 0.25));
}

/**
 * How late a bill may be before it is called late.
 *
 * Narrower than the tolerance above, because that one asks "is this the same
 * bill" of history and this one asks "should somebody look" of today. Being told
 * on the day is not useful — a bill posts a day either side routinely.
 */
function graceDays(intervalDays: number): number {
  return Math.max(3, Math.round(intervalDays * 0.15));
}

function cadenceLabel(intervalDays: number): string {
  const named = CADENCES.find(
    (cadence) => intervalDays >= cadence.min && intervalDays <= cadence.max,
  );
  return named ? named.label : `Every ${intervalDays} days`;
}

function daysBetween(earlier: Date, later: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / DAY_MS);
}

/**
 * The charges that could be a bill: money leaving, not a transfer between owned
 * accounts, not archived.
 *
 * Income is excluded because this page is about what the household owes. A
 * transfer is excluded because a card payment is not a bill — the bill was the
 * spending on the card, and counting both would show one obligation twice.
 */
export async function findRecurringBills(
  db: Db,
  timeZone: string,
  now: Date = new Date(),
): Promise<RecurringBill[]> {
  const overrides = await db.billOverride.findMany({
    select: { merchantKey: true, hidden: true, displayName: true },
  });
  const overrideFor = new Map(overrides.map((override) => [override.merchantKey, override]));

  /*
   * Charges attached by hand, and the merchant each was attached to.
   *
   * Read first so that a linked charge can be routed to its bill's group in the
   * same pass that groups everything else — and so a charge that was linked is
   * never also counted under its own description's key.
   */
  const links = await db.billLink.findMany({
    select: { merchantKey: true, transactionId: true },
  });
  const linkedTo = new Map(links.map((link) => [link.transactionId, link.merchantKey]));

  const charges = await db.transaction.findMany({
    where: {
      archivedAt: null,
      kind: 'normal',
      amountCents: { lt: 0 },
      /*
       * Pending rows come back too, and are separated below.
       *
       * A pending charge's date moves when it settles, so it must not reach the
       * interval arithmetic — that was the reason for excluding it, and the
       * reason stands. But it is the whole answer to "has this arrived?", and
       * leaving it out of that made a bill read Overdue while the payment sat in
       * the register. Fetched together and used differently.
       */
    },
    select: {
      id: true,
      description: true,
      descriptionRaw: true,
      amountCents: true,
      postedAt: true,
      pending: true,
      account: { select: { name: true, nickname: true } },
      allocations: {
        select: { delegationId: true, delegation: { select: { name: true, archivedAt: true } } },
      },
    },
    orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
    take: HISTORY_LIMIT,
  });

  type Charge = (typeof charges)[number];

  /**
   * Which bill a charge belongs to.
   *
   * A hand-made link wins over the description, which is the entire point of
   * having one: the charge arrived under a name the detection cannot connect,
   * and somebody said where it belongs.
   */
  function keyOf(charge: Charge): string {
    return linkedTo.get(charge.id) ?? merchantKey(charge.descriptionRaw || charge.description);
  }

  /** Settled charges — the only ones the schedule is fitted from. */
  const byMerchant = new Map<string, Charge[]>();
  /** Pending charges, which answer "has it arrived" and nothing else. */
  const pendingByMerchant = new Map<string, Charge[]>();

  for (const charge of charges) {
    const key = keyOf(charge);
    const into = charge.pending ? pendingByMerchant : byMerchant;
    const group = into.get(key) ?? [];
    group.push(charge);
    into.set(key, group);
  }

  const today = localDayKey(now, timeZone);
  const bills: RecurringBill[] = [];

  for (const [key, group] of byMerchant) {
    if (group.length < MIN_OCCURRENCES) continue;
    // Taken off the list by somebody who knows it is not a bill. Skipped before
    // any arithmetic, so a hidden merchant costs nothing and — the point of the
    // whole exercise — can raise no notification.
    if (overrideFor.get(key)?.hidden === true) continue;

    /*
     * Days, in the household's zone, oldest first.
     *
     * The day rather than the instant, because a bill posted at eight in the
     * evening and one posted at nine the next morning are thirteen hours apart
     * and one day apart, and it is the day that the schedule is made of.
     */
    /*
     * The schedule is fitted from charges that matched on their own, and only
     * those.
     *
     * A hand-linked charge is a correction, not evidence about the schedule. If
     * it were fitted too, linking one late payment would put a gap in the
     * history that no longer fits — and the bill would vanish from the page
     * entirely, which is a spectacularly unhelpful answer to "this did arrive".
     * So a link moves the last-seen date and never the cadence.
     */
    const own = group.filter((charge) => !linkedTo.has(charge.id));
    if (own.length < MIN_OCCURRENCES) continue;

    const days = own
      .map((charge) => localDayKey(charge.postedAt, timeZone))
      .sort((a, b) => a.getTime() - b.getTime());

    const intervals: number[] = [];
    for (let index = 1; index < days.length; index += 1) {
      // Two charges on one day are one bill paid in parts, or a duplicate.
      // Either way there is no interval between them to measure.
      const gap = daysBetween(days[index - 1]!, days[index]!);
      if (gap > 0) intervals.push(gap);
    }
    if (intervals.length < MIN_OCCURRENCES - 1) continue;

    const intervalDays = median(intervals);
    if (intervalDays < MIN_INTERVAL_DAYS || intervalDays > MAX_INTERVAL_DAYS) continue;

    const tolerance = toleranceDays(intervalDays);
    // Every gap, not most of them: one charge in the wrong place means this is
    // a merchant that is sometimes billed and sometimes visited, and a schedule
    // fitted through that is a schedule nobody can rely on.
    if (intervals.some((gap) => Math.abs(gap - intervalDays) > tolerance)) continue;

    /*
     * The last time this bill was actually paid — including a charge that was
     * linked by hand, which is the whole reason somebody linked it.
     *
     * The schedule above came from `own`; the clock runs from here. A bill told
     * that its charge arrived stops being overdue and its next date moves
     * forward by one interval, exactly as if the detection had seen it.
     */
    const settledDays = group
      .map((charge) => localDayKey(charge.postedAt, timeZone))
      .sort((a, b) => a.getTime() - b.getTime());
    const lastDay = settledDays[settledDays.length - 1]!;
    const expectedNextAt = new Date(lastDay.getTime() + intervalDays * DAY_MS);
    const grace = graceDays(intervalDays);
    const late = daysBetween(expectedNextAt, today);

    /*
     * Newest first within the group, because the *last* charge is the one whose
     * description and amount the reader is being shown.
     */
    const newest = group.reduce((latest, charge) =>
      charge.postedAt > latest.postedAt ? charge : latest,
    );
    /* The feed's own words for this merchant, which a linked charge is not. */
    const newestOwn = own.reduce((latest, charge) =>
      charge.postedAt > latest.postedAt ? charge : latest,
    );

    /*
     * A charge that has arrived but not settled, newer than the last one that
     * did. It answers this period, whatever the calendar says.
     *
     * Newer than the last settled day, because a pending row *older* than that
     * is the tail of a period already accounted for — usually a charge caught
     * mid-settlement, which would otherwise mark every bill as arrived for ever.
     */
    const pendingNewest = (pendingByMerchant.get(key) ?? [])
      .map((charge) => ({ charge, day: localDayKey(charge.postedAt, timeZone) }))
      .filter((entry) => entry.day.getTime() > lastDay.getTime())
      .sort((a, b) => b.day.getTime() - a.day.getTime())[0];

    let status: BillStatus = 'expected';
    if (pendingNewest) status = 'arrived';
    else if (late > intervalDays + grace) status = 'lapsed';
    else if (late > grace) status = 'overdue';
    else if (late >= -grace) status = 'due';

    // Where it is usually filed. A split says the charge was several things, so
    // it names no single envelope and is not counted here.
    const tally = new Map<string, { name: string; count: number }>();
    for (const charge of group) {
      const allocation = charge.allocations.length === 1 ? charge.allocations[0] : undefined;
      if (!allocation || allocation.delegation.archivedAt) continue;
      const seen = tally.get(allocation.delegationId);
      tally.set(allocation.delegationId, {
        name: allocation.delegation.name,
        count: (seen?.count ?? 0) + 1,
      });
    }
    let filedId: string | null = null;
    let filedName: string | null = null;
    let filedCount = 0;
    for (const [delegationId, entry] of tally) {
      if (entry.count > filedCount) {
        filedId = delegationId;
        filedName = entry.name;
        filedCount = entry.count;
      }
    }

    const override = overrideFor.get(key);

    bills.push({
      key,
      // The household's name where they gave one. The bank's is kept beside it
      // rather than replaced: a rename is a label, not a claim about what the
      // feed said, and reconciling against a statement needs the original.
      name: override?.displayName ?? newestOwn.description,
      /*
       * What the bank calls *this merchant*, taken from a charge that matched on
       * its own. A linked charge came in under some other name — that is why it
       * had to be linked — and showing it here would rename the bill to the
       * thing that went wrong.
       */
      feedName: newestOwn.description,
      renamed: override?.displayName != null,
      cadence: cadenceLabel(intervalDays),
      intervalDays,
      occurrences: group.length,
      // Magnitudes: the reader thinks of a bill as $118, not as −$118.
      typicalAmountCents: medianCents(group.map((charge) => -charge.amountCents)),
      lastAmountCents: -newest.amountCents,
      lastPostedAt: lastDay,
      expectedNextAt,
      status,
      daysLate: status === 'overdue' ? late : 0,
      pendingSince: pendingNewest?.day ?? null,
      // Only the settled ones are in this group; a pending linked charge is
      // counted too, because the offer to undo the link has to reach it.
      linkedCount:
        group.filter((charge) => linkedTo.has(charge.id)).length +
        (pendingByMerchant.get(key) ?? []).filter((charge) => linkedTo.has(charge.id)).length,
      delegationId: filedId,
      delegationName: filedName,
      accountName: newest.account.nickname ?? newest.account.name,
    });
  }

  /*
   * Soonest first, with anything that has plainly stopped at the bottom.
   *
   * A lapsed bill's expected date is by definition in the past, so a plain date
   * sort puts the least actionable row at the top of the page — which is exactly
   * where the first real run put a thrift shop last seen in July.
   */
  return bills.sort((a, b) => {
    const lapsed = Number(a.status === 'lapsed') - Number(b.status === 'lapsed');
    return lapsed !== 0 ? lapsed : a.expectedNextAt.getTime() - b.expectedNextAt.getTime();
  });
}

export interface HiddenBill {
  readonly key: string;
  readonly label: string;
}

/**
 * The merchants somebody has said are not bills.
 *
 * Listed so a correction can be undone. A hidden merchant has no detected bill
 * to take a name from — that is what hiding it means — so the label recorded at
 * the time is the only thing left to call it.
 */
export async function listHiddenBills(db: Db): Promise<HiddenBill[]> {
  const rows = await db.billOverride.findMany({
    where: { hidden: true },
    select: { merchantKey: true, label: true },
    orderBy: { label: 'asc' },
  });
  return rows.map((row) => ({ key: row.merchantKey, label: row.label }));
}

export interface BillOverrideInput {
  readonly key: string;
  /** What it is called now, kept so a hidden bill can still be named. */
  readonly label: string;
  readonly hidden?: boolean | undefined;
  /** A name of the household's own. Null clears it and the bank's returns. */
  readonly displayName?: string | null | undefined;
}

/**
 * Records what somebody said about a merchant.
 *
 * An upsert on the merchant key, because a correction is about the merchant
 * rather than about any one charge. A row that hides nothing and renames nothing
 * says nothing, so it is deleted rather than kept — which is not a deletion of
 * data in the sense the hard constraint means: it is the absence of an opinion,
 * and the bill it was about is derived from transactions that are all still
 * there.
 */
export async function setBillOverride(db: Db, input: BillOverrideInput): Promise<void> {
  const hidden = input.hidden ?? false;
  const displayName = input.displayName?.trim() || null;

  if (!hidden && displayName === null) {
    await db.billOverride.deleteMany({ where: { merchantKey: input.key } });
    return;
  }

  await db.billOverride.upsert({
    where: { merchantKey: input.key },
    create: { merchantKey: input.key, label: input.label, hidden, displayName },
    update: { label: input.label, hidden, displayName },
  });
}

/** What is currently recorded about a merchant, for a caller changing one part of it. */
export async function getBillOverride(
  db: Db,
  key: string,
): Promise<{ hidden: boolean; displayName: string | null } | null> {
  return db.billOverride.findUnique({
    where: { merchantKey: key },
    select: { hidden: true, displayName: true },
  });
}

/** The bills worth telling somebody about: late, and not so late they have stopped. */
export function overdueBills(bills: readonly RecurringBill[]): RecurringBill[] {
  return bills.filter((bill) => bill.status === 'overdue');
}

/**
 * "That charge is this bill."
 *
 * The escape hatch for the two cases no threshold reaches: a charge still
 * pending under a name the detection cannot connect, and a merchant that renamed
 * itself between charges so its old bill goes overdue for ever.
 *
 * One transaction belongs to at most one bill, so this moves a link rather than
 * adding a second — saying a charge belongs somewhere is also saying it does not
 * belong where it was.
 */
export async function linkChargeToBill(
  db: Db,
  input: {
    readonly key: string;
    readonly transactionId: string;
    readonly userId: string | null;
  },
): Promise<void> {
  const transaction = await db.transaction.findUnique({
    where: { id: input.transactionId },
    select: { id: true, archivedAt: true, kind: true, amountCents: true },
  });

  if (!transaction || transaction.archivedAt !== null) {
    throw new ValidationError('not_in_register', 'That transaction is not in the register.');
  }
  // The same three the detection itself reads. A bill is money going out, once,
  // as spending — an income row or a transfer is not a bill however it is filed.
  if (transaction.kind !== 'normal' || transaction.amountCents >= 0n) {
    throw new ValidationError('not_spending', 'Only ordinary spending can be attached to a bill.');
  }

  await db.billLink.upsert({
    where: { transactionId: input.transactionId },
    create: { merchantKey: input.key, transactionId: input.transactionId, linkedBy: input.userId },
    update: { merchantKey: input.key, linkedBy: input.userId },
  });
}

/** Undoes one. The charge goes back to being read by its own description. */
export async function unlinkChargeFromBill(db: Db, transactionId: string): Promise<void> {
  await db.billLink.deleteMany({ where: { transactionId } });
}

/** What is attached to a bill by hand, newest first, so it can be undone. */
export async function linkedCharges(
  db: Db,
  key: string,
): Promise<
  {
    readonly transactionId: string;
    readonly description: string;
    readonly postedAt: Date;
    readonly amountCents: Cents;
    readonly pending: boolean;
  }[]
> {
  const links = await db.billLink.findMany({
    where: { merchantKey: key },
    select: {
      transactionId: true,
      transaction: {
        select: { description: true, postedAt: true, amountCents: true, pending: true },
      },
    },
  });

  return links
    .map((link) => ({
      transactionId: link.transactionId,
      description: link.transaction.description,
      postedAt: link.transaction.postedAt,
      amountCents: -link.transaction.amountCents,
      pending: link.transaction.pending,
    }))
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
}

/**
 * How far either side of a bill's expected date to offer charges from.
 *
 * Wide enough to hold a payment that slipped a fortnight, narrow enough that the
 * list is a handful of rows rather than a second register. Somebody who needs a
 * charge from outside it can search, which is what the dialog's field is for.
 */
export const LINK_WINDOW_DAYS = 45;

/**
 * Charges that could be the one, nearest the expected date first.
 *
 * Ordered by *closeness to what is expected* rather than by date, because the
 * reader is looking for one specific payment and the machine already knows
 * roughly when it should have landed and roughly what it should have cost. The
 * one they want is usually the first row.
 */
export async function linkCandidates(
  db: Db,
  input: {
    readonly expectedNextAt: Date;
    readonly typicalAmountCents: Cents;
    readonly search: string | null;
  },
): Promise<
  {
    readonly id: string;
    readonly description: string;
    readonly postedAt: Date;
    readonly amountCents: Cents;
    readonly pending: boolean;
    readonly accountName: string;
    readonly linkedElsewhere: boolean;
  }[]
> {
  const from = new Date(input.expectedNextAt.getTime() - LINK_WINDOW_DAYS * DAY_MS);
  const to = new Date(input.expectedNextAt.getTime() + LINK_WINDOW_DAYS * DAY_MS);
  const search = input.search?.trim() ?? '';

  const rows = await db.transaction.findMany({
    where: {
      archivedAt: null,
      kind: 'normal',
      amountCents: { lt: 0 },
      // A search is a deliberate act and reaches the whole register; without one
      // the offer is the window around the date this bill was expected.
      ...(search === '' ? { postedAt: { gte: from, lte: to } } : {}),
      ...(search === '' ? {} : { description: { contains: search, mode: 'insensitive' as const } }),
    },
    select: {
      id: true,
      description: true,
      postedAt: true,
      amountCents: true,
      pending: true,
      account: { select: { name: true, nickname: true } },
      billLink: { select: { merchantKey: true } },
    },
    orderBy: [{ postedAt: 'desc' }],
    take: 200,
  });

  const expected = input.expectedNextAt.getTime();
  const typical = input.typicalAmountCents;

  return rows
    .map((row) => ({
      id: row.id,
      description: row.description,
      postedAt: row.postedAt,
      amountCents: -row.amountCents,
      pending: row.pending,
      accountName: row.account.nickname ?? row.account.name,
      // Said on the row rather than hidden, because attaching it here takes it
      // off whatever bill it is on now.
      linkedElsewhere: row.billLink !== null,
    }))
    .sort((a, b) => {
      // Days from the expected date, then how far the amount is off, in that
      // order: a bill arrives on roughly the right day far more reliably than
      // for exactly the right amount.
      const dayGap =
        Math.abs(a.postedAt.getTime() - expected) - Math.abs(b.postedAt.getTime() - expected);
      if (Math.abs(dayGap) > DAY_MS) return dayGap;

      const amountGap =
        Number(a.amountCents - typical < 0n ? typical - a.amountCents : a.amountCents - typical) -
        Number(b.amountCents - typical < 0n ? typical - b.amountCents : b.amountCents - typical);
      return amountGap;
    })
    .slice(0, 25);
}
