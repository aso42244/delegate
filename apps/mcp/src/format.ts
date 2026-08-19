/**
 * Turning the API's shapes into something a language model reads well.
 *
 * Two decisions run through this file.
 *
 * **Money becomes dollars, formatted, as text.** Cents cross the wire as
 * decimal strings (ADR 002) and stay exact all the way here — the conversion
 * below is the display edge, exactly as it is in the web client. A model asked
 * to reason about `-421000` will sometimes decide it is four hundred thousand
 * dollars; `-$4,210.00` it reads correctly every time.
 *
 * **Output is compact text, not JSON.** Every token a tool returns is a token
 * the conversation cannot spend on anything else, and a JSON dump of a hundred
 * transactions is mostly punctuation and repeated keys.
 */

/** Cents as a decimal string — the wire format — to `$1,234.56`. */
export function money(cents: string | null | undefined): string {
  if (cents === null || cents === undefined) return '—';

  const value = BigInt(cents);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;

  const dollars = (magnitude / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const remainder = (magnitude % 100n).toString().padStart(2, '0');

  return `${negative ? '-' : ''}$${dollars}.${remainder}`;
}

/** An ISO timestamp as `2026-08-19`. Time of day is never the question here. */
export function day(iso: string | null | undefined): string {
  return iso === null || iso === undefined ? '—' : iso.slice(0, 10);
}

/** Satoshis to BTC, at eight decimal places, without going through a float. */
export function bitcoin(sats: string | null | undefined): string {
  if (sats === null || sats === undefined) return '—';

  const value = BigInt(sats);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, '0');
  return `${whole.toString()}.${fraction} BTC`;
}

/**
 * A fixed-width table.
 *
 * Alignment is not decoration: a column of right-aligned amounts is read as a
 * column, and a model comparing two rows of an unaligned list has to parse
 * rather than look.
 */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '(nothing)';

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );

  /*
   * Amounts are right-aligned; text is not.
   *
   * An em-dash means "nothing here" and belongs to whichever kind of column it
   * lands in, so it does not get a vote — otherwise a column of them alone
   * reads as numeric and an Envelope column of empties comes back
   * right-aligned against a left-aligned header.
   */
  const numeric = headers.map((_header, index) => {
    const filled = rows.map((row) => row[index] ?? '').filter((cell) => cell !== '—');
    return filled.length > 0 && filled.every((cell) => /^-?\$?[\d,]/.test(cell));
  });

  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, index) =>
        numeric[index] ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!),
      )
      .join('  ')
      .trimEnd();

  return [
    render(headers),
    render(widths.map((width) => '-'.repeat(width))),
    ...rows.map(render),
  ].join('\n');
}

/** The reply shape every tool returns. */
export function text(body: string): {
  content: { type: 'text'; text: string }[];
} {
  return { content: [{ type: 'text', text: body }] };
}
