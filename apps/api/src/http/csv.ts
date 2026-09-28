/**
 * Writing CSV.
 *
 * The export exists because this household came from a spreadsheet and should be
 * able to get back to one — at tax time, to cross-check a figure against the
 * bank, or to look at a year in a way this application does not offer. Until
 * now the only way data left was a `pg_dump` nobody can read.
 *
 * Two things here are deliberate and neither is obvious.
 */

/**
 * Money as a plain decimal, not as cents.
 *
 * [ADR 002](../../../../docs/decisions/002-money-as-integer-cents.md) says cents
 * travel as decimal strings over HTTP, and that is about JSON, where the risk is
 * a float silently losing a cent. A CSV is opened in a spreadsheet, and a column
 * of `-4210` that should read `-42.10` is a column somebody will sum and act on.
 *
 * Formatted from the integer by hand rather than through `Number`, so the value
 * never passes through a float on its way out.
 */
export function csvMoney(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * The characters a spreadsheet reads as the start of a formula.
 *
 * A description is bank text and nobody here controls it. Excel and Sheets both
 * treat a cell beginning with one of these as a formula rather than as text, and
 * `=HYPERLINK(...)` in a merchant name is a real way to hand somebody a
 * document that does something when they open it.
 */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * A value that is not text and must not be defended against.
 *
 * A negative amount begins with `-`, which is also how a formula begins, so a
 * guard applied to everything would turn every debit into an apostrophe and a
 * string. Wrapping says "this one I generated" — a date, a figure, a count —
 * and text is everything else, which is to say everything the feed wrote.
 */
export interface CsvRaw {
  readonly raw: string;
}

export function raw(value: string): CsvRaw {
  return { raw: value };
}

export type CsvValue = string | number | null | undefined | CsvRaw;

/**
 * One field, quoted and escaped.
 *
 * Quoting is unconditional rather than clever. A bank description contains
 * commas, quotes and newlines often enough that deciding per field is a decision
 * somebody gets wrong once, and a quoted field is valid CSV either way.
 */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return `"${value}"`;
  if (typeof value === 'object') return `"${value.raw.replaceAll('"', '""')}"`;

  const guarded =
    value.length > 0 && FORMULA_LEADERS.has(value[0]!)
      ? // A leading apostrophe is how a spreadsheet is told "this is text". It
        // shows in the formula bar rather than in the cell.
        `'${value}`
      : value;

  return `"${guarded.replaceAll('"', '""')}"`;
}

export function csvRow(fields: readonly CsvValue[]): string {
  return `${fields.map(csvField).join(',')}\n`;
}

/**
 * A whole file: the header row, then the data rows.
 *
 * Built in memory rather than streamed. A household's register is thousands of
 * rows and a decade of them is tens of thousands — a few megabytes of string on
 * a machine that runs Postgres beside it. Streaming would be the right answer at
 * a size this will not reach, and the wrong complexity to carry until it does.
 */
export function csvFile(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return header.map((name) => csvField(raw(name))).join(',') + '\n' + rows.map(csvRow).join('');
}
