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
 * **A card states how much of the row it needs.** Settings is laid out as three
 * columns on a wide screen, and a card that holds three radio buttons has no
 * business taking the width of one that holds a table of forty rules. `span` is
 * how it says so, and it defaults to the whole row — a card that has not thought
 * about it keeps exactly the width it always had.
 */
/**
 * Written out rather than interpolated, because Tailwind reads the source for
 * class names and never sees one that was assembled at runtime.
 */
const SPANS: Record<1 | 2 | 3, string> = {
  1: 'lg:col-span-1',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
};

export function SettingsCard({
  title,
  description,
  action,
  span = 3,
  children,
}: {
  readonly title: string;
  readonly description: string;
  /** Rendered right-aligned, baseline-aligned with the title. */
  readonly action?: ReactNode;
  /** How many of the three columns this needs on a wide screen. */
  readonly span?: 1 | 2 | 3;
  readonly children: ReactNode;
}): ReactNode {
  return (
    // `min-w-0`: a grid item defaults to its content width, so a card holding a
    // table would size the column rather than the column sizing the table.
    <section className={`min-w-0 rounded-lg border border-line bg-canvas p-4 ${SPANS[span]}`}>
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
