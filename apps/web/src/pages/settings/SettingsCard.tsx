import type { ReactNode } from 'react';
import { Tile, type TileSpan } from '../../components/Tile.jsx';

/**
 * A settings card is a tile.
 *
 * It was its own box — same radius, same border, same padding, a 14px heading
 * where a tile's is 16px, and a six-column grid where Overview's is twelve. So
 * `half` meant one thing on Settings and another on Overview, and a page of
 * cards and a page of tiles did not look like the same application. There is one
 * box now (`components/Tile.tsx`) and one grid, and this is the name Settings
 * knows it by — see ADR 061.
 *
 * The action stays in the header for the reason it always did: a page that lists
 * things and also creates them should not carry the creating form all the way
 * down the page, below the list, permanently open.
 *
 * **A card states how much of the row it needs.** A card holding three radio
 * buttons has no business taking the width of one holding a table of forty
 * rules. `span` is how it says so, and it defaults to the whole row — a card
 * that has not thought about it keeps the width it always had.
 */
export type CardSpan = TileSpan;

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
    <Tile
      span={span}
      title={title}
      description={description}
      {...(action === undefined ? {} : { actions: action })}
    >
      {children}
    </Tile>
  );
}
