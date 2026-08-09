/**
 * Money primitives.
 *
 * Hard constraint: all money is integer cents, stored in BIGINT columns and
 * carried through the application as `bigint`. `number` is never used for
 * monetary arithmetic — a JS number cannot represent every value a BIGINT
 * column can hold, and floating point cannot represent most cent values
 * exactly. Formatting to a decimal string happens only at the display edge.
 *
 * `Cents` is an alias for `bigint`, not a branded type. A brand would force an
 * `as Cents` cast at every Prisma boundary — and a cast asserts rather than
 * checks, so the safety would be theatre while the noise would be real. The
 * protection that matters is at the one place a lossy value can enter: `cents()`
 * rejects non-integer numbers outright. Everything else is bigint end to end,
 * and every field, column and parameter carries a `Cents` suffix.
 */

export type Cents = bigint;

export const ZERO_CENTS: Cents = 0n;

/** Wraps an integer as Cents. Rejects non-integer numbers outright. */
export function cents(value: bigint | number): Cents {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(`Cents must be a whole number of cents, received ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`Cents value ${value} exceeds the safe integer range`);
    }
    return BigInt(value);
  }
  return value;
}

export function addCents(a: Cents, b: Cents): Cents {
  return a + b;
}

export function subCents(a: Cents, b: Cents): Cents {
  return a - b;
}

export function negateCents(a: Cents): Cents {
  return -a;
}

export function absCents(a: Cents): Cents {
  return a < 0n ? -a : a;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Accepts the forms a human actually types into a spreadsheet-style cell:
 * `1234.5`, `$1,234.56`, `-12`, `(12.34)` (accounting negative), `.5`, `1.`.
 *
 * More than two decimal places is an error rather than a silent round. Silently
 * turning `1.005` into `1.00` in financial software is worse than telling the
 * user the cell is wrong.
 */
const MONEY_PATTERN = /^(?<sign>[-+])?\$?(?<whole>\d{1,3}(?:,\d{3})*|\d*)(?:\.(?<frac>\d*))?$/;

export class MoneyParseError extends Error {
  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`Cannot read "${input}" as an amount: ${reason}`);
    this.name = 'MoneyParseError';
  }
}

export function parseMoney(input: string): Cents {
  let text = input.trim();
  if (text === '') throw new MoneyParseError(input, 'it is empty');

  // Accounting notation: (12.34) means -12.34.
  let negatedByParens = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negatedByParens = true;
    text = text.slice(1, -1).trim();
  }

  const match = MONEY_PATTERN.exec(text);
  if (!match?.groups) throw new MoneyParseError(input, 'it is not a number');

  const { sign, whole, frac } = match.groups;
  const digits = (whole ?? '').replace(/,/g, '');
  if (digits === '' && (frac === undefined || frac === '')) {
    throw new MoneyParseError(input, 'it has no digits');
  }
  if (frac !== undefined && frac.length > 2) {
    throw new MoneyParseError(input, 'amounts cannot be finer than one cent');
  }
  if (negatedByParens && sign !== undefined) {
    throw new MoneyParseError(input, 'it has two negative signs');
  }

  const fractional = (frac ?? '').padEnd(2, '0');
  const magnitude = BigInt(digits === '' ? '0' : digits) * 100n + BigInt(fractional);
  const isNegative = negatedByParens || sign === '-';
  return isNegative ? -magnitude : magnitude;
}

export function tryParseMoney(
  input: string,
): { ok: true; value: Cents } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseMoney(input) };
  } catch (error) {
    if (error instanceof MoneyParseError) return { ok: false, error: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export interface FormatMoneyOptions {
  /** Include the `$` symbol. Default true. */
  readonly currencySymbol?: boolean;
  /** Group thousands with commas. Default true. */
  readonly grouping?: boolean;
  /** Render negatives as `(1.23)` instead of `-1.23`. Default false. */
  readonly accountingNegative?: boolean;
  /** Always show a leading `+` on positive values. Default false. */
  readonly explicitPlus?: boolean;
}

/** USD only, by constraint — there is no locale or currency parameter. */
export function formatCents(value: Cents, options: FormatMoneyOptions = {}): string {
  const {
    currencySymbol = true,
    grouping = true,
    accountingNegative = false,
    explicitPlus = false,
  } = options;

  const isNegative = value < 0n;
  const magnitude = isNegative ? -value : value;
  const whole = magnitude / 100n;
  const fraction = magnitude % 100n;

  const wholeText = grouping
    ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : whole.toString();
  const body = `${currencySymbol ? '$' : ''}${wholeText}.${fraction.toString().padStart(2, '0')}`;

  if (isNegative) return accountingNegative ? `(${body})` : `-${body}`;
  return explicitPlus && value > 0n ? `+${body}` : body;
}

/** The plain form used to prefill an editable cell: `1234.56`, `-12.00`. */
export function formatCentsForInput(value: Cents): string {
  return formatCents(value, { currencySymbol: false, grouping: false });
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

/**
 * Splits an amount into `parts` shares that sum to exactly the original.
 *
 * The remainder is handed out one cent at a time from the first share onward,
 * so $10.00 across 3 becomes 3.34 / 3.33 / 3.33. Negatives are split on the
 * magnitude and re-signed, which keeps `sum(result) === total` in every case.
 */
export function splitEvenly(total: Cents, parts: number): Cents[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError(`Cannot split into ${parts} parts`);
  }
  const sign = total < 0n ? -1n : 1n;
  const magnitude = total < 0n ? -total : total;
  const divisor = BigInt(parts);
  const base = magnitude / divisor;
  const remainder = magnitude % divisor;

  return Array.from({ length: parts }, (_, index) => {
    const share = base + (BigInt(index) < remainder ? 1n : 0n);
    return share * sign;
  });
}

/**
 * Distributes an amount in proportion to non-negative weights, using the
 * largest-remainder method so the shares sum to exactly the original. Ties go
 * to the earlier index, which makes the result deterministic and testable.
 */
export function allocateByWeight(total: Cents, weights: readonly bigint[]): Cents[] {
  if (weights.length === 0) throw new RangeError('Cannot allocate across zero weights');
  if (weights.some((weight) => weight < 0n)) {
    throw new RangeError('Allocation weights cannot be negative');
  }
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightTotal === 0n) throw new RangeError('Allocation weights sum to zero');

  const sign = total < 0n ? -1n : 1n;
  const magnitude = total < 0n ? -total : total;

  const floors = weights.map((weight) => (magnitude * weight) / weightTotal);
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (magnitude * weight) % weightTotal,
  }));

  let leftover = magnitude - floors.reduce((sum, share) => sum + share, 0n);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (leftover <= 0n) break;
    floors[index] = (floors[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return floors.map((share) => share * sign);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify` throws on bigint, so every money value crossing the HTTP
 * boundary is carried as a decimal *string* of cents (`"-12345"`). A string
 * survives JSON, sorts unambiguously, and cannot be silently coerced to a
 * lossy float by a client.
 */
export function centsToJson(value: Cents): string {
  return value.toString();
}

export function centsFromJson(value: string): Cents {
  if (!/^-?\d+$/.test(value)) {
    throw new TypeError(`Expected a whole number of cents as a string, received "${value}"`);
  }
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// Bitcoin
// ---------------------------------------------------------------------------

/**
 * Bitcoin is held as a **quantity**, never as a dollar value: the holding is a
 * number of satoshis, and its worth is that quantity times the price on the date
 * being displayed. Storing a dollar value would freeze a number that changes by
 * the minute, and would make the net worth chart wrong for every historical date.
 */
export const SATS_PER_BITCOIN = 100_000_000n;

/**
 * What a holding is worth at a given price, in cents.
 *
 * Integer throughout, rounded half away from zero at the final division — the
 * same rule the rest of this module uses. A float here would be a rounding error
 * multiplied by a hundred million.
 */
export function bitcoinValueCents(sats: Cents, priceCentsPerBitcoin: Cents): Cents {
  const product = sats * priceCentsPerBitcoin;
  const sign = product < 0n ? -1n : 1n;
  const magnitude = product < 0n ? -product : product;

  // + half the divisor before truncating: rounds .5 away from zero.
  return sign * ((magnitude + SATS_PER_BITCOIN / 2n) / SATS_PER_BITCOIN);
}

/**
 * Reads a quantity of Bitcoin as satoshis: `0.05` becomes `5_000_000`.
 *
 * Eight decimal places exactly, because that is what a satoshi is. A ninth is
 * rejected rather than rounded — the same rule as a third decimal place on a
 * dollar amount, and for the same reason: silently discarding precision in
 * financial software is worse than saying the input is wrong.
 */
const BITCOIN_PATTERN = /^(\d*)(?:\.(\d*))?$/;

export function parseBitcoin(input: string): bigint {
  const text = input.trim().replace(/,/g, '');
  if (text === '') throw new MoneyParseError(input, 'it is empty');

  const match = BITCOIN_PATTERN.exec(text);
  if (!match) throw new MoneyParseError(input, 'it is not a quantity of Bitcoin');

  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') throw new MoneyParseError(input, 'it has no digits');
  if (fraction.length > 8) {
    throw new MoneyParseError(input, 'Bitcoin cannot be divided finer than one satoshi');
  }

  return BigInt(whole === '' ? '0' : whole) * SATS_PER_BITCOIN + BigInt(fraction.padEnd(8, '0'));
}

export function tryParseBitcoin(
  input: string,
): { ok: true; value: bigint } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseBitcoin(input) };
  } catch (error) {
    if (error instanceof MoneyParseError) return { ok: false, error: error.message };
    throw error;
  }
}

/** The full eight places, for prefilling a field so it round-trips exactly. */
export function formatBitcoinForInput(sats: bigint): string {
  const whole = sats / SATS_PER_BITCOIN;
  const fraction = sats % SATS_PER_BITCOIN;
  return `${whole}.${fraction.toString().padStart(8, '0')}`;
}

/** For display: trailing zeros trimmed, but never to a bare integer. */
export function formatBitcoin(sats: bigint): string {
  const full = formatBitcoinForInput(sats);
  const trimmed = full.replace(/0+$/, '');
  return trimmed.endsWith('.') ? `${trimmed}0` : trimmed;
}
