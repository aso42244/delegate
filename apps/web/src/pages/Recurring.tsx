import { useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { BillsView } from './Bills.jsx';
import { UtilitiesView } from './Utilities.jsx';
import { PageHeader, SegmentedControl } from '../components/layout.jsx';

/**
 * Recurring.
 *
 * Bills and Utilities were two sidebar entries over the same rows. Both are
 * worked out from the register and neither stores anything; both are lists of
 * the same recurring merchants — and Electricity was on both of them, described
 * two different ways. That is the confusion one page fixes and two pages cannot.
 *
 * They are not the same *question*, which is why this is two views rather than
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
 * Neither answer is in the other, so neither view is a filter of the other. What
 * they share is the header and one place in the sidebar.
 *
 * **The glance lives on Overview.** Five tiles read the same two builders — what
 * is coming, what needs a look, what this cycle's bills come to, which way each
 * utility is going, and which are worth adjusting. This page is where something
 * is *changed*: renaming a bill, attaching a charge to one, dismissing one.
 */

const VIEWS = [
  { value: 'due', label: 'Due' },
  { value: 'cost', label: 'Cost' },
] as const;

type View = (typeof VIEWS)[number]['value'];

export function Recurring(): ReactNode {
  /*
   * The view is in the URL, like Overview's period and the register's filters.
   * A view kept in component state resets every time somebody follows a link
   * out and comes back — which is exactly how Insights lost its window on every
   * navigation, including on a press of one of its own tiles.
   */
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'cost' ? 'cost' : 'due';

  function setView(next: string): void {
    const updated = new URLSearchParams(params);
    if (next === 'due') updated.delete('view');
    else updated.set('view', next);
    setParams(updated, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Recurring"
        actions={
          <SegmentedControl
            label="What to show"
            value={view}
            options={[...VIEWS]}
            onChange={setView}
          />
        }
      />

      {view === 'due' ? <BillsView /> : <UtilitiesView />}
    </div>
  );
}
