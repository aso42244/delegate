import type { HTMLAttributes, ReactNode } from 'react';

/**
 * The tile: the one box this application draws things in.
 *
 * There were three of these and they were the same object drawn three times —
 * Overview's `TileShell`, Settings' `SettingsCard`, and the bordered `<section>`
 * every page reached for when it wanted a box. Same radius, same border, same
 * padding, three headings at two sizes, and a footer rule that four tiles on
 * Overview each drew for themselves inside their own body.
 *
 * None of them was wrong. Together they were why a page of tiles and a page of
 * cards did not look like the same application — see
 * `docs/decisions/061-every-page-is-a-page-of-tiles.md`.
 *
 * **A tile is a surface, a header and a body**, and the header and the footer
 * are the shell's rather than the content's. A footer drawn inside a scrolling
 * body scrolls away, which is exactly what "All bills →" did on a tile with
 * eleven bills in it.
 */

/**
 * How much of a row a tile takes.
 *
 * **Twelve columns, one vocabulary.** Settings counted in sixths and Overview in
 * twelfths, so `half` meant `col-span-3` on one page and `col-span-6` on the
 * other — two grids, two meanings for one word. Twelve divides by 2, 3 and 4
 * with nothing left over, which is every fraction either page ever wanted.
 *
 * Written out rather than interpolated: Tailwind reads the source for the class
 * names it emits and never sees one assembled at runtime.
 */
const SPANS = {
  third: 'md:col-span-6 lg:col-span-4',
  half: 'md:col-span-6 lg:col-span-6',
  'two-thirds': 'md:col-span-12 lg:col-span-8',
  full: 'md:col-span-12 lg:col-span-12',
} as const;

export type TileSpan = keyof typeof SPANS;

export function tileSpanClass(span: TileSpan): string {
  return SPANS[span];
}

/**
 * A grid of tiles.
 *
 * One column on a phone, twelve from `md`, and 24px between them — the
 * card-to-card step from `ui-system.md` §1, which is what both grids were
 * already using before they were one grid.
 */
export function TileGrid({
  children,
  className = '',
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return <div className={`grid grid-cols-1 gap-6 md:grid-cols-12 ${className}`}>{children}</div>;
}

/**
 * One cell of the grid, holding tiles stacked down it.
 *
 * A grid cell rather than two tiles each declaring a third: two spans only look
 * like a column by coincidence, and inserting anything between them produces an
 * arrangement nobody asked for. The same argument `ui-system.md` §2 makes for
 * Overview's rows, one axis over.
 */
export function TileColumn({
  span,
  children,
}: {
  readonly span: TileSpan;
  readonly children: ReactNode;
}): ReactNode {
  return <div className={`flex min-w-0 flex-col gap-6 ${tileSpanClass(span)}`}>{children}</div>;
}

export function Tile({
  title,
  lead,
  description,
  headingLevel = 2,
  actions,
  footer,
  span,
  filled = false,
  overlay,
  className = '',
  children,
  ...section
}: {
  /**
   * The tile's heading, 16px semibold — a section title, which is what a tile's
   * heading is. Optional: a tile whose content carries its own heading in the
   * column it totals (the budget's tables) is a surface and nothing more.
   */
  readonly title?: string;
  /**
   * A reading in the header's left-hand track, for a tile whose name is carried
   * somewhere other than a heading.
   *
   * The budget band is the one of these: it is the page's first block and says
   * so by being it, so its header's left side is free for the fact a reader
   * wants there — which payday cycle this is and how far through it. Left,
   * because it is being read; the controls stay right, where a control is
   * looked for.
   *
   * Never both this and `title`: they occupy the same track, and a tile that
   * wants a heading and a reading wants `description`.
   */
  readonly lead?: ReactNode;
  /** One line, at most, and the current fact rather than an instruction. */
  readonly description?: string;
  /**
   * Which heading this title is, and it is almost always the default.
   *
   * `3` is for a tile nested under a heading of its own — the Arrange picker,
   * whose cards sit under "Add a tile". A picker card drawn as an `h2` competes
   * with the real tiles for the same accessible name, so asking for "Net worth"
   * on a page that also offers "What net worth is made of" finds two things and
   * a document outline that claims the chooser is a peer of what it chooses
   * from.
   */
  readonly headingLevel?: 2 | 3;
  /** This tile's own controls, on the right of its header. */
  readonly actions?: ReactNode;
  /**
   * A rule and a line of small print at the foot.
   *
   * Part of the shell rather than the last child of the body, because the body
   * is what scrolls: a footer inside it is a footer that scrolls away.
   */
  readonly footer?: ReactNode;
  /** How much of the row this needs. Omit outside a `TileGrid`. */
  readonly span?: TileSpan;
  /**
   * The body takes the room left over and clips what does not fit, for a tile
   * whose height is set from outside. Off by default: a tile is as tall as what
   * is in it.
   */
  readonly filled?: boolean;
  /** Absolutely-positioned furniture — a drag grip, a resize handle, a drop edge. */
  readonly overlay?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'className' | 'children'>): ReactNode {
  return (
    /*
     * `@container` so what is inside can ask how wide *this tile* is. A `sm:`
     * breakpoint asks how wide the window is, which is the wrong question the
     * moment a tile stops being the whole row: a third-width tile on a 1440px
     * screen is 345px across and was being handed the layout meant for a 640px
     * one. That is how the backups table drew its columns past its own border.
     *
     * `min-w-0` because a grid item defaults to its content width, so a tile
     * holding a table would size the column rather than the column sizing the
     * table.
     *
     * **`group/tile`, never a bare `group`.** A bare one is the same group the
     * table rows inside use: `.group:hover .row-menu-trigger` reveals a row's
     * `⋯` and its absorb button, and it matches *any* hovered ancestor carrying
     * the class. With the tile in that group, hovering anywhere over the budget
     * drew "Move surplus here" on every line at once — and `.group:focus-within`
     * meant a press into the register's search box did the same to fifty rows.
     * A named group is a group of one.
     *
     * **`h-full` only where there is a `span`**, which is to say only where this
     * tile is a cell of the grid. That is the only place ending level with a
     * neighbour means anything — and `height: 100%` anywhere else is actively
     * wrong: inside a stretched flex column each tile resolves it against the
     * *column's* height and they all become as tall as the row, stacked on top
     * of one another. Overview's sidebar did exactly that, and the symptom was a
     * button in the budget panel that could not be clicked because the tile
     * below it was drawn over the whole column.
     */
    <section
      className={`@container group/tile relative flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-canvas p-4 ${
        span === undefined ? '' : `h-full ${tileSpanClass(span)}`
      } ${className}`}
      {...section}
    >
      {overlay}

      {/*
        The same shape as `PageHeader`: title, actions on the right, one line of
        description underneath at the 4px step. A header is a header, whether it
        belongs to a page or to a tile — and it was three shapes before, with the
        description beside the title on Overview and under it on Settings.
      */}
      {(title !== undefined || lead !== undefined || actions !== undefined) && (
        /*
         * One row that wraps, rather than a title row nested inside a header
         * block. Flat on purpose: the heading is a direct child of the tile's
         * header and the header a direct child of the tile, which is the shape
         * every test that reaches a tile from its heading walks. A layout that
         * needs an extra `<div>` to hold two lines is a layout asking every
         * caller to know how deep it goes.
         *
         * `gap-y-1` is the 4px step, so the description sits 4px under the title
         * and a row of actions that has to wrap does too.
         */
        <div className="grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-1">
          {title !== undefined &&
            (headingLevel === 3 ? (
              <h3 className="min-w-0 truncate text-section font-semibold text-ink">{title}</h3>
            ) : (
              <h2 className="min-w-0 truncate text-section font-semibold text-ink">{title}</h2>
            ))}
          {lead !== undefined && <div className="min-w-0">{lead}</div>}
          {/* `col-start-2`, so a tile with controls and no title — the register,
              whose page header already says "Transactions" — still puts them on
              the right rather than in the title's track. */}
          {actions !== undefined && (
            <div className="col-start-2 flex min-w-0 flex-wrap items-center justify-end gap-2">
              {actions}
            </div>
          )}
          {/* A line of its own under the title rather than beside it — which is
              where it was on Overview and under it on Settings, one of the three
              header shapes ADR 061 deleted. */}
          {description !== undefined && (
            <p className="col-span-2 text-quiet text-muted">{description}</p>
          )}
        </div>
      )}

      {/*
        `min-h-0` because a flex item's minimum is its content, which would
        otherwise push the tile back to its natural height whatever the row was
        dragged to.

        `overflow-hidden` rather than `auto`: a scrolling body and a scrolling
        list inside it are two scrollbars for one overflow, and the outer one
        takes the whole tile with it — so a short row clipped its chart halfway
        instead of shortening the list beside it. A chart scales to the room it
        is given; a list scrolls in place.
      */}
      <div
        className={
          filled ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'flex min-h-0 flex-col'
        }
      >
        {children}
      </div>

      {footer !== undefined && (
        <div className="shrink-0 border-t border-line pt-2 text-micro text-muted">{footer}</div>
      )}
    </section>
  );
}
