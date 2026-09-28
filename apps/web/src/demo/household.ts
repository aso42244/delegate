/**
 * The demo household.
 *
 * Everything here is invented and always has been: no real balance, account,
 * institution or person, and none ever should be. That is the point of it — the
 * demo exists so the application can be shown without showing anybody's money.
 *
 * ## Why it is here and not in a database
 *
 * The first version of this was a second container with its own database, its
 * own migrations and a seed that wrote eighteen months of rows. That is the
 * right shape for a demo the public can reach, and completely wrong for one
 * behind the household's own sign-in: it is a page, and a page needs data, not
 * a deployment.
 *
 * So the numbers are computed in the browser and handed to the same components
 * the real pages use. Nothing is stored, nothing can be written, and there is
 * nothing to keep running.
 *
 * ## Why it always looks current
 *
 * Every date is counted backwards from **today**, on every render. A demo shown
 * in March and the same demo shown in July are both up to date, with a partial
 * month at the top of the outflow band and a pay cycle part-way through.
 */

/** A whole number of cents. Money is integer cents everywhere — ADR 002. */
type Cents = number;

/** How much history the charts draw. */
const MONTHS = 18;

/** The household is paid every other Friday. */
const CYCLE_DAYS = 14;
const CYCLES_PER_YEAR = 26;

/**
 * Deterministic randomness.
 *
 * A demo that reshuffles itself on every render is one where a figure somebody
 * pointed at a moment ago has moved. Seeded from the day, so it is stable while
 * it is being shown and still drifts from week to week.
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

/** Midday, so no rounding of a date can move a charge across a boundary. */
export function daysAgo(days: number): Date {
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

export const GROUPINGS = [
  { key: 'home', name: 'Home', color: 'var(--color-group-blue)' },
  { key: 'food', name: 'Food', color: 'var(--color-group-orange)' },
  { key: 'vehicles', name: 'Vehicles', color: 'var(--color-group-green)' },
  { key: 'health', name: 'Health', color: 'var(--color-group-purple)' },
  { key: 'family', name: 'Family', color: 'var(--color-group-teal)' },
  { key: 'giving', name: 'Giving', color: 'var(--color-group-pink)' },
] as const;

export type GroupingKey = (typeof GROUPINGS)[number]['key'];

export interface Line {
  readonly id: string;
  readonly name: string;
  readonly grouping: GroupingKey;
  readonly utility: boolean;
}

export const LINES: readonly Line[] = [
  { id: 'mortgage', name: 'Mortgage', grouping: 'home', utility: false },
  { id: 'electricity', name: 'Electricity', grouping: 'home', utility: true },
  { id: 'gas', name: 'Natural Gas', grouping: 'home', utility: true },
  { id: 'water', name: 'Water & Sewer', grouping: 'home', utility: true },
  { id: 'upkeep', name: 'Home Maintenance', grouping: 'home', utility: false },
  { id: 'groceries', name: 'Groceries', grouping: 'food', utility: true },
  { id: 'dining', name: 'Dining Out', grouping: 'food', utility: false },
  { id: 'fuel', name: 'Gasoline', grouping: 'vehicles', utility: true },
  { id: 'carins', name: 'Car Insurance', grouping: 'vehicles', utility: false },
  { id: 'carfix', name: 'Vehicle Maintenance', grouping: 'vehicles', utility: false },
  { id: 'medical', name: 'Medical', grouping: 'health', utility: false },
  { id: 'pharmacy', name: 'Pharmacy', grouping: 'health', utility: false },
  { id: 'subs', name: 'Subscriptions', grouping: 'family', utility: false },
  { id: 'kids', name: 'Kids Activities', grouping: 'family', utility: false },
  { id: 'household', name: 'Household Money', grouping: 'family', utility: false },
  { id: 'giving', name: 'Giving', grouping: 'giving', utility: false },
];

/**
 * What actually gets charged, and how often.
 *
 * The merchant names are invented and deliberately look like a bank feed —
 * uppercase, a store number, a town — because that is what the register has to
 * be legible against.
 */
interface Charge {
  readonly line: string;
  readonly merchant: string;
  readonly cents: Cents;
  readonly spread: number;
  readonly cadence: 'monthly' | 'weekly' | 'cycle';
  readonly dayOfMonth?: number;
  readonly peakMonth?: number;
  readonly depth?: number;
}

export const CHARGES: readonly Charge[] = [
  {
    line: 'mortgage',
    merchant: 'MIDWEST HOME LOANS PMT',
    cents: 185_000,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 1,
  },
  {
    line: 'electricity',
    merchant: 'PRAIRIE POWER & LIGHT',
    cents: 14_500,
    spread: 0.08,
    cadence: 'monthly',
    dayOfMonth: 12,
    peakMonth: 7,
    depth: 0.45,
  },
  {
    line: 'gas',
    merchant: 'NORTHERN GAS UTILITY',
    cents: 9_500,
    spread: 0.1,
    cadence: 'monthly',
    dayOfMonth: 15,
    peakMonth: 0,
    depth: 0.7,
  },
  {
    line: 'water',
    merchant: 'CITY WATER AND SEWER',
    cents: 8_900,
    spread: 0.06,
    cadence: 'monthly',
    dayOfMonth: 18,
  },
  {
    line: 'carins',
    merchant: 'HERITAGE MUTUAL INS',
    cents: 19_200,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 22,
  },
  {
    line: 'subs',
    merchant: 'STREAMBOX MONTHLY',
    cents: 1_899,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 9,
  },
  {
    line: 'subs',
    merchant: 'CLOUDSTORE PLAN',
    cents: 3_499,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 24,
  },
  {
    line: 'giving',
    merchant: 'RIVERSIDE CHURCH GIVING',
    cents: 48_000,
    spread: 0,
    cadence: 'monthly',
    dayOfMonth: 3,
  },
  {
    line: 'groceries',
    merchant: 'HY-MART #1418 CEDARVILLE',
    cents: 14_200,
    spread: 0.35,
    cadence: 'weekly',
  },
  {
    line: 'groceries',
    merchant: 'CORNER MARKET CEDARVILLE',
    cents: 4_100,
    spread: 0.4,
    cadence: 'weekly',
  },
  { line: 'fuel', merchant: 'QUICKFUEL #221', cents: 5_600, spread: 0.25, cadence: 'weekly' },
  { line: 'dining', merchant: 'THE BLUE SPOON CAFE', cents: 4_800, spread: 0.4, cadence: 'weekly' },
  {
    line: 'pharmacy',
    merchant: 'CEDARVILLE PHARMACY',
    cents: 2_600,
    spread: 0.5,
    cadence: 'cycle',
  },
  { line: 'kids', merchant: 'CEDARVILLE PARKS & REC', cents: 8_500, spread: 0.2, cadence: 'cycle' },
  {
    line: 'household',
    merchant: 'GENERAL STORE CEDARVILLE',
    cents: 3_900,
    spread: 0.45,
    cadence: 'cycle',
  },
  {
    line: 'medical',
    merchant: 'CEDARVILLE FAMILY CLINIC',
    cents: 9_500,
    spread: 0.6,
    cadence: 'monthly',
    dayOfMonth: 20,
  },
  {
    line: 'upkeep',
    merchant: 'BUILDERS SUPPLY CO',
    cents: 11_500,
    spread: 0.7,
    cadence: 'monthly',
    dayOfMonth: 26,
  },
  {
    line: 'carfix',
    merchant: 'CEDARVILLE AUTO SERVICE',
    cents: 14_000,
    spread: 0.6,
    cadence: 'monthly',
    dayOfMonth: 14,
  },
];

/** Take-home, every other Friday. */
export const PAY_CENTS = 271_500;

/**
 * How much of a buffer each line is funded with, over what it actually costs.
 *
 * Small, deliberately. A household that funds every line generously ends the
 * year with everything climbing and nothing to look at; the interesting thing
 * about an envelope budget is the lines that *drift*.
 */
const BUFFER = 0.04;

/**
 * What one Delegate press puts into a line — derived from the charges.
 *
 * Chosen by hand it produced a household whose every line climbed for eighteen
 * months, because each guess was comfortably over what that line actually spent.
 * Sized to the spending, the balances hover, which is what puts a line in the
 * red occasionally and gives the pace bars something to say.
 */
export function perCycleFor(lineId: string): Cents {
  const yearly = CHARGES.filter((charge) => charge.line === lineId).reduce((total, charge) => {
    const times = charge.cadence === 'monthly' ? 12 : charge.cadence === 'weekly' ? 52 : 26;
    return total + charge.cents * times;
  }, 0);
  return Math.round(((yearly / CYCLES_PER_YEAR) * (1 + BUFFER)) / 100) * 100;
}

export interface Charged {
  readonly at: Date;
  readonly description: string;
  /** Signed: negative is money leaving the account. */
  readonly cents: Cents;
  readonly line: string | null;
  readonly kind: 'normal' | 'income';
}

/** Every pay day in the window, oldest first. */
export function payDays(): Date[] {
  const days: Date[] = [];
  // Five days into the current cycle: far enough that the ticks have moved,
  // early enough that nothing looks spent.
  for (let back = 5; back <= MONTHS * 31; back += CYCLE_DAYS) days.push(daysAgo(back));
  return days.reverse();
}

function monthlyDates(dayOfMonth: number, from: Date, to: Date): Date[] {
  const dates: Date[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), dayOfMonth, 12, 0, 0, 0);
  while (cursor <= to) {
    if (cursor >= from) dates.push(new Date(cursor.getTime()));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return dates;
}

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

/**
 * Everything that happened, as a flat dated list, oldest first.
 *
 * Computed once and cached for the life of the tab: it is the same eighteen
 * months whichever page asks, and recomputing it per request would make two
 * tiles disagree about the same household.
 */
let cached: Charged[] | null = null;

export function history(): Charged[] {
  if (cached) return cached;

  const to = daysAgo(0);
  const from = daysAgo(MONTHS * 31);
  const random = rng(Math.floor(to.getTime() / 86_400_000));
  const about = (cents: number, spread: number): number =>
    Math.round((cents * (1 + (random() * 2 - 1) * spread)) / 100) * 100;

  const rows: Charged[] = [];

  for (const at of payDays()) {
    rows.push({
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
      if (at > to || at < from) continue;
      const season =
        charge.peakMonth === undefined ? 1 : seasonal(at, charge.peakMonth, charge.depth ?? 0.3);
      rows.push({
        at,
        description: charge.merchant,
        cents: -about(Math.round(charge.cents * season), charge.spread),
        line: charge.line,
        kind: 'normal',
      });
    }
  }

  cached = rows.sort((a, b) => a.at.getTime() - b.at.getTime());
  return cached;
}

/**
 * What each line holds now.
 *
 * Delegated once a cycle for every cycle but the last, less what it spent. The
 * newest pay packet is left undistributed on purpose: Delegate is the action
 * this application is named for, and a demo that opens with the button greyed
 * out has to be explained rather than shown.
 */
export function balances(): Map<string, Cents> {
  const held = new Map<string, Cents>();
  const runs = payDays().length - 1;

  /*
   * What each line was holding when the window opens.
   *
   * Two cycles, because a household that has been doing this a while is
   * carrying a buffer — and without one the arithmetic here very nearly
   * cancels: eighteen months of funding against eighteen months of spending
   * leaves every line hovering at zero, so the ordinary week-to-week noise puts
   * most of them in the red at once. A page where everything is over-spent
   * reads as a broken budget rather than a working one.
   */
  const OPENING_CYCLES = 2;

  for (const line of LINES) {
    held.set(line.id, perCycleFor(line.id) * (runs + OPENING_CYCLES));
  }
  for (const row of history()) {
    if (row.line === null) continue;
    held.set(row.line, (held.get(row.line) ?? 0) + row.cents);
  }
  return held;
}

/** What the newest, undelegated pay packet came to. */
export function waitingToDelegate(): Cents {
  const last = payDays()[payDays().length - 1];
  if (!last) return 0;
  return history()
    .filter((row) => row.kind === 'income' && row.at.getTime() >= last.getTime())
    .reduce((total, row) => total + row.cents, 0);
}
