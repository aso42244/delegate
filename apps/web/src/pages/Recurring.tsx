import type { ReactNode } from 'react';
import { BillsView } from './Bills.jsx';
import { UtilitiesView } from './Utilities.jsx';
import { PageHeader } from '../components/layout.jsx';
import { TileColumn, TileGrid } from '../components/Tile.jsx';

/**
 * Recurring.
 *
 * Bills and Utilities were two sidebar entries over the same rows. Both are
 * worked out from the register and neither stores anything; both are lists of
 * the same recurring merchants — and Electricity was on both of them, described
 * two different ways. That is the confusion one page fixes and two pages cannot.
 *
 * They are not the same *question*, which is why they are two tiles rather than
 * one list:
 *
 * - **Due** watches time. Did a charge that should have landed, land? A failed
 *   autopay and a cancelled service look identical from inside a budget — no
 *   transaction, which is also what a quiet week looks like — and stay invisible
 *   until a balance is wrong or a letter arrives.
 * - **Cost** judges amount. Is this line funded at what it actually costs? The
 *   arithmetic the owner used to do by hand: what does the water bill average
 *   over a year, and what is that per paycheck.
 *
 * **Both are on the screen at once now** (ADR 061). They were two views behind a
 * segmented control, and a switch between two answers that are never in each
 * other is a switch somebody has to press to find out which one they wanted —
 * the price of which was that the page could only ever answer half of what it
 * knows. Due takes two-thirds because it is a seven-column table; Cost is a
 * column of dense lists, which read down to about 300px and no further.
 *
 * The two old addresses still resolve here, which is the promise a bookmark is
 * owed: `/bills` and `/utilities` both land on the page carrying both halves.
 *
 * **The glance lives on Overview.** Five tiles read the same two builders — what
 * is coming, what needs a look, what this cycle's bills come to, which way each
 * utility is going, and which are worth adjusting. This page is where something
 * is *changed*: renaming a bill, attaching a charge to one, dismissing one.
 */
export function Recurring(): ReactNode {
  return (
    <div>
      <PageHeader title="Recurring" />

      <TileGrid>
        <BillsView />

        {/*
          A column rather than two more tiles in the grid: the Cost tiles belong
          together and sit one above the other whatever the row does, which a
          grid cell says and a pair of spans only agrees to by coincidence.
        */}
        <TileColumn span="third">
          <UtilitiesView />
        </TileColumn>
      </TileGrid>
    </div>
  );
}
