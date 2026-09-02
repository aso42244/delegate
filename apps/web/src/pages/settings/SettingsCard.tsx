import type { ReactNode } from 'react';

/**
 * A settings card: bordered, a 14px heading, one line of grey description, and
 * an optional action in the top right.
 *
 * The action belongs in the header for the same reason it does on the Budget
 * page: a page that lists things and also creates them should not carry the
 * creating form all the way down the page, below the list, permanently open.
 * One button, one dialog, and the list keeps the room.
 *
 * **A card states how much of the row it needs.** A card that holds three radio
 * buttons has no business taking the width of one that holds a table of forty
 * rules. `span` is how it says so — a third, a half, two-thirds or the whole
 * row — and it defaults to the whole row.
 *
 * **Cards on one line end level.** The grid stretches them and the card is a
 * column, so the border reaches the bottom of the tallest one beside it rather
 * than stopping where its own content happens to stop.
 */
/**
 * Six columns underneath, four widths on top.
 *
 * Three columns could not say "two side by side" — a half is not a whole number
 * of thirds — so the grid counts in sixths and a card names a fraction rather
 * than a column count. `full` is the default, so a card that has not thought
 * about it keeps the width it always had.
 *
 * Written out rather than interpolated, because Tailwind reads the source for
 * class names and never sees one assembled at runtime.
 */
const WIDTHS = {
  third: 'lg:col-span-2',
  half: 'lg:col-span-3',
  'two-thirds': 'lg:col-span-4',
  full: 'lg:col-span-6',
} as const;

export type CardSpan = keyof typeof WIDTHS;

export function SettingsCard({
  title,
  description,
  action,
  span = 'full',
  children,
}: {
  readonly title: string;
  readonly description: string;
  /** Rendered right-aligned, baseline-aligned with the title. */
  readonly action?: ReactNode;
  /**
   * How much of the row this needs on a wide screen.
   *
   * `span`, not `width`: a field's `width` is its own scale in this codebase
   * (`ui-system.md` §2), and two vocabularies under one prop name is a trap for
   * whoever reads it next.
   */
  readonly span?: CardSpan;
  readonly children: ReactNode;
}): ReactNode {
  return (
    /*
     * `min-w-0`: a grid item defaults to its content width, so a card holding a
     * table would size the column rather than the column sizing the table.
     *
     * `h-full` so cards on one line end level. Grid stretches its items by
     * default, but the section is what is stretched — without this the content
     * keeps its own height and the border stops where the content does, which
     * is what made three radio groups draw three different boxes.
     *
     * `@container` so what is inside can ask how wide *this card* is.
     * A `sm:` breakpoint asks how wide the window is, which is the wrong
     * question the moment a card stops being the whole row: a third-width card
     * on a 1440px screen is 345px across and was being handed the layout meant
     * for a 640px one. That is how the backups table came to draw its columns
     * past the card's own border. Every card is a container; content inside one
     * uses `@sm:`/`@md:`/`@lg:`, never `sm:`.
     */
    <section
      className={`@container flex h-full min-w-0 flex-col rounded-lg border border-line bg-canvas p-4 ${WIDTHS[span]}`}
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        {/* `min-w-0` so a long description wraps rather than shoving the action
            onto a line of its own. */}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <p className="text-quiet text-muted">{description}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
