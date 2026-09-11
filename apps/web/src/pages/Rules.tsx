import type { ReactNode } from 'react';
import { PageHeader } from '../components/layout.jsx';
import { TileGrid } from '../components/Tile.jsx';
import { RulesSection } from './settings/Rules.jsx';

/**
 * Auto-categorization rules, as a page of their own.
 *
 * They lived under Settings, which is where a thing that is configured once
 * belongs. Rules are not that. They are written from the Transactions page while
 * categorizing, reordered when one shadows another, and read whenever a charge
 * lands somewhere surprising — the same rhythm as the register itself, and three
 * clicks away from it.
 *
 * The card keeps its own shape. What changed is where it is reached from, so the
 * body is the section as it was rather than a second implementation of it.
 */
export function Rules(): ReactNode {
  return (
    /*
     * No gap of its own.
     *
     * `PageHeader` carries the 24px between a title and the page beneath it —
     * that is the whole reason the step lives in the component rather than in
     * each caller. Wrapping it in a `gap-6` column added a second one, so the
     * tile on this page started 48px below its title while every tile on
     * Overview started 24px below its own. One page's worth of drift, invisible
     * until the two are looked at side by side.
     */
    <div>
      <PageHeader title="Rules" />
      <TileGrid>
        <RulesSection />
      </TileGrid>
    </div>
  );
}
