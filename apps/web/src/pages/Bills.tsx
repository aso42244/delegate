import { formatCents } from '@budget/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { recurringApi, type BillDto, type BillStatus } from '../api/recurring.js';
import { EmptyState, PageHeader } from '../components/layout.jsx';
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
  expected: 'Expected',
  lapsed: 'Stopped?',
};

const STATUS_TONE: Record<BillStatus, string> = {
  overdue: 'text-danger font-semibold',
  due: 'text-accent font-semibold',
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

function BillRow({ bill }: { readonly bill: BillDto }): ReactNode {
  return (
    <tr className="border-b border-line">
      <td className="row-cell pr-3 pl-3">
        <span className="block truncate text-ink" title={bill.name}>
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
      <td className="row-cell pr-3 overflow-hidden">
        <span className="block truncate text-quiet text-muted">{bill.delegationName ?? '—'}</span>
      </td>
      <td className="row-cell pr-3 whitespace-nowrap">
        <span className={`text-quiet ${STATUS_TONE[bill.status]}`}>
          {STATUS_TEXT[bill.status]}
          {bill.status === 'overdue' && ` · ${bill.daysLate}d`}
        </span>
      </td>
    </tr>
  );
}

/** The same bill on a phone: what it is and what it costs, then when and where. */
function BillCard({ bill }: { readonly bill: BillDto }): ReactNode {
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
      </div>
    </li>
  );
}

export function Bills(): ReactNode {
  const [search, setSearch] = useState('');
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
        (bill.delegationName ?? '').toLowerCase().includes(needle) ||
        (bill.accountName ?? '').toLowerCase().includes(needle),
    );
  }, [all, search]);

  const overdue = all.filter((bill) => bill.status === 'overdue').length;

  return (
    <div>
      {/*
        The subtitle states the current fact, which for this page is the count
        and whether any of it needs attention — never an explanation of how the
        detection works. That belongs in the ADR, not on the screen every day.
      */}
      <PageHeader
        title="Bills"
        subtitle={
          bills.isLoading
            ? undefined
            : all.length === 0
              ? undefined
              : overdue > 0
                ? `${all.length} recurring, ${overdue} overdue.`
                : `${all.length} recurring.`
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search bills, delegation or account"
          aria-label="Search bills"
          className="field min-w-64 flex-1 rounded-lg border border-line bg-canvas px-3 text-base"
        />
      </div>

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
            <BillCard key={bill.key} bill={bill} />
          ))}
        </ul>
      ) : (
        <table className="w-full border-t-2 border-ink md:table-fixed">
          <thead>
            <tr className="text-label uppercase tracking-[0.05em] text-muted">
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
              */}
              <th className="row-cell pr-3 pl-3 text-left font-normal">Bill</th>
              <th className="row-cell pr-3 text-left font-normal md:w-32">Every</th>
              <th className="row-cell pr-3 text-left font-normal md:w-24">Next</th>
              <th className="row-cell pr-3 text-right font-normal md:w-32">Typical</th>
              <th className="row-cell pr-3 text-right font-normal md:w-32">Last</th>
              <th className="row-cell pr-3 text-left font-normal md:w-32">Delegation</th>
              <th className="row-cell pr-3 text-left font-normal md:w-28">Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((bill) => (
              <BillRow key={bill.key} bill={bill} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
