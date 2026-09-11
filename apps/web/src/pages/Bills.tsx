import { formatCents } from '@budget/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { recurringApi, type BillDto, type BillStatus } from '../api/recurring.js';
import { BillRowMenu } from '../components/BillRowMenu.jsx';
import { EmptyState, SearchField } from '../components/layout.jsx';
import { Tile } from '../components/Tile.jsx';
import { Alert } from '../components/ui.jsx';
import { NARROW, useMediaQuery } from '../useMediaQuery.js';

/**
 * Bills.
 *
 * Everything on this page is worked out from the register and nothing on it is
 * stored. A bill is a merchant whose charges have landed at a steady interval,
 * which is a fact already in the transactions — asking the household to keep a
 * second list of the same thing would produce a list that is wrong within a
 * month, and wrong in the direction nobody notices.
 *
 * The question it exists for is **the bill that did not arrive**. A failed
 * autopay and a cancelled service look identical from inside the budget — no
 * transaction, which is also what a quiet week looks like — and stay invisible
 * until a balance is wrong or a letter comes. The rest of the page is the same
 * data answering the easier question of what is coming.
 */

/**
 * Words as well as colour.
 *
 * `design.md` §9: never convey state by colour alone. The status column says
 * what it is; the colour is how fast it is read, not what it means.
 */
const STATUS_TEXT: Record<BillStatus, string> = {
  overdue: 'Overdue',
  due: 'Due now',
  // The money has gone and the bank has not finished with it. Said as a fact
  // about the charge rather than as a state of the bill, because that is what
  // the reader is checking against their own account.
  arrived: 'Paid, pending',
  expected: 'Expected',
  lapsed: 'Stopped?',
};

const STATUS_TONE: Record<BillStatus, string> = {
  overdue: 'text-danger font-semibold',
  due: 'text-accent font-semibold',
  // Positive, and not bold: nothing here needs doing, which is the whole point.
  arrived: 'text-positive',
  expected: 'text-muted',
  lapsed: 'text-faint',
};

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A price that has moved.
 *
 * The whole reason both figures are on the row: a subscription that renewed
 * higher is perfectly ordinary until the two sit beside each other. A tenth is
 * the threshold — below that it is a meter reading, above it something changed.
 */
function priceRose(bill: BillDto): boolean {
  const typical = BigInt(bill.typicalAmountCents);
  const last = BigInt(bill.lastAmountCents);
  return typical > 0n && last * 10n > typical * 11n;
}

function BillRow({
  bill,
  onProblem,
}: {
  readonly bill: BillDto;
  readonly onProblem: (message: string) => void;
}): ReactNode {
  return (
    // `group` so the row's menu appears on hover of the row rather than only of
    // the trigger itself.
    <tr
      className="group border-b border-line"
      title={`${bill.name} · ${bill.cadence} · ${STATUS_TEXT[bill.status]}${
        bill.delegationName === null ? '' : ` · ${bill.delegationName}`
      }`}
    >
      <td className="row-cell pr-3 pl-3">
        {/*
          The name, and only the name.

          The bank's description was drawn under it in small grey, which put a
          line of feed text on every renamed row — the exact noise renaming was
          for. It is still kept and still searchable; it lives in the row menu
          now, where somebody reconciling against a statement can go and look at
          it, and nowhere else.
        */}
        <span className="block truncate text-ink" title={bill.feedName}>
          {bill.name}
        </span>
      </td>
      <td className="row-cell pr-3 text-quiet whitespace-nowrap text-muted">{bill.cadence}</td>
      {/* The two "when" facts together, then the two figures together: a
          right-aligned column meeting a left-aligned one is a seam, and one
          seam reads better than two. */}
      <td className="row-cell pr-3 text-quiet whitespace-nowrap text-muted">
        {shortDate(bill.expectedNextAt)}
      </td>
      <td className="money row-cell pr-3 whitespace-nowrap">
        {formatCents(BigInt(bill.typicalAmountCents))}
      </td>
      <td className="money row-cell pr-3 whitespace-nowrap">
        <span className={priceRose(bill) ? 'font-semibold text-warning' : 'text-muted'}>
          {formatCents(BigInt(bill.lastAmountCents))}
        </span>
      </td>
      {/*
        The column that gives way.

        Everything else on this row answers "did the charge arrive"; where the
        money comes out of is a fact about the budget rather than about the
        bill's schedule, and it is the row's only column whose content repeats
        the merchant name on most rows. So it is drawn where the tile is wide
        enough to afford it and carried in the row's hover text otherwise —
        `@2xl`, which is this tile's own width rather than the window's.
      */}
      <td className="row-cell pr-3 hidden overflow-hidden @3xl:table-cell">
        <span className="block truncate text-quiet text-muted">{bill.delegationName ?? '—'}</span>
      </td>
      <td className="row-cell pr-3 whitespace-nowrap">
        <span className={`text-quiet ${STATUS_TONE[bill.status]}`}>
          {STATUS_TEXT[bill.status]}
          {bill.status === 'overdue' && ` · ${bill.daysLate}d`}
        </span>
      </td>

      <td className="hold-to-open-cell row-cell">
        <BillRowMenu bill={bill} onProblem={onProblem} />
      </td>
    </tr>
  );
}

/** The same bill on a phone: what it is and what it costs, then when and where. */
function BillCard({
  bill,
  onProblem,
}: {
  readonly bill: BillDto;
  readonly onProblem: (message: string) => void;
}): ReactNode {
  return (
    <li className="border-b border-line py-2.5 last:border-0">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-ink" title={bill.name}>
          {bill.name}
        </span>
        <span className="flex-1" />
        <span
          className={`money text-hero ${priceRose(bill) ? 'font-semibold text-warning' : 'text-ink'}`}
        >
          {formatCents(BigInt(bill.lastAmountCents))}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <span className={`shrink-0 text-quiet ${STATUS_TONE[bill.status]}`}>
          {STATUS_TEXT[bill.status]}
          {bill.status === 'overdue' && ` · ${bill.daysLate}d`}
        </span>
        <span className="min-w-0 flex-1 truncate text-label text-faint">
          {bill.cadence} · next {shortDate(bill.expectedNextAt)}
          {bill.delegationName ? ` · ${bill.delegationName}` : ''}
        </span>

        {/* Always drawn on a touchscreen: the rule that hides a row menu is a
            hover a phone cannot perform. */}
        <span className="-mr-1 shrink-0">
          <BillRowMenu bill={bill} onProblem={onProblem} />
        </span>
      </div>
    </li>
  );
}

/**
 * The Due half of Recurring: what is coming, and what did not come.
 *
 * A tile beside Cost rather than a page of its own — see ADR 061. Two things
 * left it in that change and both were the owner's call:
 *
 * **The count is gone.** "10 recurring." said how many merchants this household
 * repeats with, which is a fact about how long it has been running rather than
 * about the list somebody came to work through — the same argument that took
 * "494 transactions" off the register in v0.34.
 *
 * **The hidden fold is gone**, and the corrections it held moved to
 * Settings → Archived. It is a list of things somebody put away with a way to
 * put them back, which is precisely what that page is, and it sat under a page
 * that is now a tile beside another tile with nowhere sensible for a fold. The
 * rule it was written for still holds: a correction nobody can find is one
 * nobody can undo, so it moved rather than went.
 */
export function BillsView(): ReactNode {
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const bills = useQuery({ queryKey: ['recurring'], queryFn: recurringApi.list });
  const narrow = useMediaQuery(NARROW);

  const all = useMemo(() => bills.data?.bills ?? [], [bills.data]);
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return all;
    // The delegation as well as the merchant: "which bills come out of Home"
    // is the other way somebody looks for one.
    return all.filter(
      (bill) =>
        bill.name.toLowerCase().includes(needle) ||
        // The bank's text as well as the household's name for it: a rename must
        // not make a bill unfindable by what the statement calls it.
        bill.feedName.toLowerCase().includes(needle) ||
        (bill.delegationName ?? '').toLowerCase().includes(needle) ||
        (bill.accountName ?? '').toLowerCase().includes(needle),
    );
  }, [all, search]);

  return (
    <Tile
      span="two-thirds"
      title="Due"
      /* Due and Cost sit side by side now, so what each half asks has to be on
         the tile: the segmented control that used to name them is gone. */
      description="What is coming, and what did not come"
      actions={
        <SearchField
          value={search}
          onChange={setSearch}
          label="Search bills"
          placeholder="Search bills, delegation or account"
        />
      }
    >
      {problem && (
        <div className="mb-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      {bills.isLoading ? (
        <p className="text-quiet text-muted">Loading bills…</p>
      ) : all.length === 0 ? (
        /*
         * One sentence and no instructions — the text budget. It says why there
         * is nothing rather than nothing at all, because "no bills" and "not
         * enough history to tell yet" are genuinely different states and a
         * household three weeks in is always in the second.
         */
        <EmptyState>No bill has arrived three times yet.</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState>No bill matches that.</EmptyState>
      ) : narrow ? (
        <ul className="border-t-2 border-ink">
          {shown.map((bill) => (
            <BillCard key={bill.key} bill={bill} onProblem={setProblem} />
          ))}
        </ul>
      ) : (
        /* A wide table scrolls inside its own tile rather than squeezing, which
           is design.md §8 and the only honest answer where the tile is narrower
           than the columns need. */
        <div className="overflow-x-auto">
          <table className="w-full border-t-2 border-ink @xl:table-fixed">
            <thead>
              <tr className="text-label uppercase tracking-label text-muted">
                {/*
                No width on the name: under a fixed layout the unsized column
                takes what the others leave, which is the right job for the one
                whose content has no upper bound — a merchant name is as long as
                the bank feels like making it.

                Which means every other width is taken *out* of that one. A
                "last seen" column was here and is gone: the cadence says how
                often, Next says when, and an overdue row already carries how
                many days late it is, so it was a fourth way of saying the same
                thing paid for out of the only column that needed the room.

                **`@xl` rather than `xl`.** These widths are a claim about how
                much room the *tile* has, and this tile is two-thirds of the page
                — asking the window would hand a 656px tile the layout meant for
                1280, which is exactly how the backups table drew its columns
                past its own border in v0.49.

                Measured at the widths this tile actually has: the fixed columns
                come to 464px, so the merchant name gets about 250 of a 756px
                tile on a 1440px screen. It was 124 with the delegation drawn at
                `@2xl`, which truncated "Water & Sewer - City of Sioux Falls" to
                "Water & Sew…" — the column that has no upper bound paying for
                the one that repeats it.
              */}
                <th className="row-cell pr-3 pl-3 text-left font-normal">Bill</th>
                {/* Each of these is sized to the longest thing it can hold and no
                  wider — "Every two months", "$1,234.56" — because every pixel
                  they take comes out of the merchant name beside them. */}
                {/* "Cadence", not "Every": the cell under it reads "Monthly", and
                  "Every Monthly" is not a sentence. */}
                <th className="row-cell pr-3 text-left font-normal @xl:w-28">Cadence</th>
                <th className="row-cell pr-3 text-left font-normal @xl:w-16">Next</th>
                <th className="row-cell pr-3 text-right font-normal @xl:w-24">Typical</th>
                <th className="row-cell pr-3 text-right font-normal @xl:w-24">Last</th>
                <th className="row-cell pr-3 hidden text-left font-normal @3xl:table-cell @3xl:w-28">
                  Delegation
                </th>
                <th className="row-cell pr-3 text-left font-normal @xl:w-24">Status</th>
                <th className="hold-to-open-cell row-cell" />
              </tr>
            </thead>
            <tbody>
              {shown.map((bill) => (
                <BillRow key={bill.key} bill={bill} onProblem={setProblem} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Tile>
  );
}
