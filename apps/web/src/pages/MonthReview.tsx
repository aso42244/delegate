import { formatCents, groupingTint } from '@budget/shared';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  monthReviewApi,
  type MonthBillDto,
  type MonthFiguresDto,
  type MonthReviewDto,
} from '../api/month-review.js';
import { registerHref } from '../components/drill.js';
import { EmptyState, PageHeader } from '../components/layout.jsx';
import { Tag } from '../components/Tag.jsx';
import { Tile, TileColumn, TileGrid } from '../components/Tile.jsx';
import { Alert, Button } from '../components/ui.jsx';

/**
 * Month in review: one finished month, read back from the ledger (ADR 078).
 *
 * Computed when it is opened and never stored, so a charge filed late lands in
 * the month it belongs to the next time the month is looked at. Read-only:
 * nothing on this page writes, and every figure that sums transactions opens
 * them (ADR 077).
 *
 * The month lives in the URL, as Overview's links do, so a month can be linked
 * to and Back returns to it.
 */

/** "2026-09" as "September 2026". */
function monthName(month: string, style: 'long' | 'short' = 'long'): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(year!, index! - 1, 1).toLocaleDateString(undefined, {
    month: style,
    ...(style === 'long' ? { year: 'numeric' } : {}),
  });
}

/** "2026-09-14" as "Sep 14", in the reader's locale but never their zone. */
function dayName(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** How a figure compares with the month before, in words. */
function against(current: bigint, previous: bigint | undefined, month: string): string {
  if (previous === undefined) return 'No month before to compare';
  const name = monthName(month, 'short');
  const difference = current - previous;
  if (difference === 0n) return `Same as ${name}`;
  return difference > 0n
    ? `${formatCents(difference)} more than ${name}`
    : `${formatCents(-difference)} less than ${name}`;
}

function FigureCell({
  label,
  value,
  note,
  tone = 'ink',
  href,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly tone?: 'ink' | 'positive' | 'negative';
  readonly href?: string;
}): ReactNode {
  const colour =
    tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-ink';
  const body = (
    <>
      <span className="text-micro font-semibold tracking-[0.07em] text-muted uppercase">
        {label}
      </span>
      {/* `self-start`: `.money` aligns right, which in a column is the far edge. */}
      <span className={`money self-start text-figure font-bold ${colour}`}>{value}</span>
      <span className="text-quiet text-muted">{note}</span>
    </>
  );
  return href === undefined ? (
    <div className="flex flex-col gap-1">{body}</div>
  ) : (
    <Link
      to={href}
      className="-m-1 flex flex-col gap-1 rounded p-1 hover:bg-surface"
      title={`Open the transactions behind ${label}`}
    >
      {body}
    </Link>
  );
}

/** The five figures of a line or a grouping, as cells. Start and Moved are a laptop's. */
function FigureCells({
  figures,
  spentHref,
  emphasis = 'normal',
}: {
  readonly figures: MonthFiguresDto;
  readonly spentHref: string;
  readonly emphasis?: 'normal' | 'total';
}): ReactNode {
  const ink = emphasis === 'total' ? 'text-ink' : 'text-muted';
  return (
    <>
      <td className={`money hidden row-cell pr-3 sm:table-cell ${ink}`}>
        {formatCents(BigInt(figures.startCents))}
      </td>
      <td className={`money row-cell pr-3 ${ink}`}>
        {formatCents(BigInt(figures.delegatedCents))}
      </td>
      <td className={`money hidden row-cell pr-3 sm:table-cell ${ink}`}>
        {formatCents(BigInt(figures.movedCents), { explicitPlus: true })}
      </td>
      <td className="money row-cell pr-3">
        <Link className="linkish" to={spentHref}>
          {formatCents(BigInt(figures.spentCents))}
        </Link>
      </td>
      <td
        className={`money row-cell pr-3 ${BigInt(figures.endCents) < 0n ? 'text-negative' : 'text-ink'}`}
      >
        {formatCents(BigInt(figures.endCents))}
      </td>
    </>
  );
}

/**
 * Each line from where it started to where it ended, by grouping (ADR 078).
 *
 * Start, plus what Delegate gave, plus what was moved in or out, less what was
 * spent, is where it ended — so a line funded by a transfer, or carrying last
 * month's balance, reads as what it was rather than as overspent.
 *
 * Groupings start closed, each showing its lines' totals, the way the budget is
 * read: by grouping first, a line only when the grouping asks a question.
 */
function LinesTable({ review }: { readonly review: MonthReviewDto }): ReactNode {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const label = monthName(review.month);
  const uncategorized = BigInt(review.uncategorizedCents);
  const wentOut = BigInt(review.wentOutCents);
  const range = { kind: 'normal' as const, dateFrom: review.from, dateBefore: review.before };

  if (review.groupings.length === 0 && uncategorized === 0n) {
    return <EmptyState>Nothing was held, delegated or spent in {label}.</EmptyState>;
  }

  const sum = (pick: (figures: MonthFiguresDto) => string): bigint =>
    review.groupings.reduce((total, grouping) => total + BigInt(pick(grouping)), 0n);

  function toggle(key: string): void {
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <table className="w-full border-t-2 border-ink">
      <thead>
        <tr className="text-label uppercase tracking-label text-muted">
          <th className="row-cell pl-3 text-left font-normal">Line</th>
          <th className="hidden w-28 row-cell pr-3 text-right font-normal sm:table-cell">Start</th>
          <th className="w-28 row-cell pr-3 text-right font-normal">Delegated</th>
          <th className="hidden w-28 row-cell pr-3 text-right font-normal sm:table-cell">Moved</th>
          <th className="w-28 row-cell pr-3 text-right font-normal">Spent</th>
          <th className="w-28 row-cell pr-3 text-right font-normal">End</th>
        </tr>
      </thead>
      <tbody>
        {review.groupings.map((grouping) => {
          const key = grouping.id ?? 'none';
          const expanded = open.has(key);
          return (
            <Fragment key={key}>
              <tr
                className="border-b border-line"
                style={{ background: groupingTint(grouping.color, 'header') ?? undefined }}
              >
                {/* `max-w-0` and `w-full`: the name takes what the figures leave
                    and truncates there, never wrapping a row onto a second line. */}
                <td className="row-cell w-full max-w-0 pl-3">
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-expanded={expanded}
                    className="group/toggle -ml-1 flex max-w-full items-center gap-1 rounded font-semibold text-ink"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted group-hover/toggle:bg-surface-2 group-hover/toggle:text-ink">
                      <svg
                        viewBox="0 0 20 20"
                        className="h-[18px] w-[18px]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d={expanded ? 'M5 8l5 5 5-5' : 'M8 5l5 5-5 5'} />
                      </svg>
                    </span>
                    <span className="truncate">{grouping.name}</span>
                  </button>
                </td>
                <FigureCells
                  figures={grouping}
                  emphasis="total"
                  spentHref={registerHref(
                    { groupingId: key, ...range },
                    { label: `${grouping.name} in ${label}`, cents: BigInt(grouping.spentCents) },
                  )}
                />
              </tr>
              {expanded &&
                grouping.lines.map((line) => (
                  <tr
                    key={line.delegationId}
                    className="border-b border-line"
                    style={{ background: groupingTint(grouping.color, 'row') ?? undefined }}
                  >
                    <td className="row-cell w-full max-w-0 pl-8 text-ink">
                      <span
                        className="block truncate"
                        title={line.archived ? `${line.name} (archived)` : line.name}
                      >
                        {line.name}
                        {line.archived && <span className="text-muted"> (archived)</span>}
                      </span>
                    </td>
                    <FigureCells
                      figures={line}
                      spentHref={registerHref(
                        { delegationId: line.delegationId, ...range },
                        { label: `${line.name} in ${label}`, cents: BigInt(line.spentCents) },
                      )}
                    />
                  </tr>
                ))}
            </Fragment>
          );
        })}

        {/* Part of what went out and in no line yet, so Spent adds up to it. */}
        {uncategorized !== 0n && (
          <tr className="border-b border-line">
            <td className="row-cell w-full max-w-0 pl-3 text-muted">
              <span className="block truncate">Not categorized yet</span>
            </td>
            <td className="money hidden row-cell pr-3 text-muted sm:table-cell">—</td>
            <td className="money row-cell pr-3 text-muted">—</td>
            <td className="money hidden row-cell pr-3 text-muted sm:table-cell">—</td>
            <td className="money row-cell pr-3">
              <Link
                className="linkish"
                to={registerHref(
                  { uncategorized: true, dateFrom: review.from, dateBefore: review.before },
                  { label: `Not categorized in ${label}`, cents: uncategorized },
                )}
              >
                {formatCents(uncategorized)}
              </Link>
            </td>
            <td className="money row-cell pr-3 text-muted">—</td>
          </tr>
        )}

        <tr className="border-t-2 border-ink font-bold">
          <td className="row-cell pl-3 text-ink">All of it</td>
          <td className="money hidden row-cell pr-3 text-ink sm:table-cell">
            {formatCents(sum((figures) => figures.startCents))}
          </td>
          <td className="money row-cell pr-3 text-ink">
            {formatCents(sum((figures) => figures.delegatedCents))}
          </td>
          <td className="money hidden row-cell pr-3 text-ink sm:table-cell">
            {formatCents(
              sum((figures) => figures.movedCents),
              { explicitPlus: true },
            )}
          </td>
          <td className="money row-cell pr-3 text-ink">{formatCents(wentOut)}</td>
          <td className="money row-cell pr-3 text-ink">
            {formatCents(sum((figures) => figures.endCents))}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function BillRow({ bill }: { readonly bill: MonthBillDto }): ReactNode {
  const { move } = bill;
  const detail =
    move.kind === 'moved'
      ? `usually ${formatCents(BigInt(move.typicalCents))}`
      : move.kind === 'new'
        ? `first seen ${dayName(move.day)}`
        : `due ${dayName(move.expectedDay)}, usually ${formatCents(BigInt(move.typicalCents))}`;

  const tag =
    move.kind === 'moved' ? (
      <Tag tone={move.changeBasisPoints > 0 ? 'warning' : 'positive'}>
        {`${move.changeBasisPoints > 0 ? '+' : '−'}${Math.round(Math.abs(move.changeBasisPoints) / 100)}%`}
      </Tag>
    ) : move.kind === 'new' ? (
      <Tag tone="info">new</Tag>
    ) : (
      <Tag>didn&apos;t arrive</Tag>
    );

  const body = (
    <>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-ink">{bill.name}</span>
        <span className="text-quiet text-muted">{detail}</span>
      </span>
      <span className="flex shrink-0 items-baseline gap-2">
        {tag}
        {move.kind !== 'missed' && (
          <span className="money font-semibold text-ink">
            {formatCents(BigInt(move.amountCents))}
          </span>
        )}
      </span>
    </>
  );

  return (
    <li className="border-b border-line last:border-0">
      {move.kind === 'missed' ? (
        <div className="flex items-baseline justify-between gap-2 py-2">{body}</div>
      ) : (
        // The day's register, where the charge is.
        <Link
          to={registerHref({ day: move.day })}
          className="flex items-baseline justify-between gap-2 rounded py-2 hover:bg-surface"
        >
          {body}
        </Link>
      )}
    </li>
  );
}

function NetWorthTile({ review }: { readonly review: MonthReviewDto }): ReactNode {
  const worth = review.netWorth;
  if (worth === null) {
    return <EmptyState>The nightly snapshots do not cover this month yet.</EmptyState>;
  }
  const change = BigInt(worth.endCents) - BigInt(worth.startCents);
  const bitcoin = BigInt(worth.bitcoinChangeCents);
  const rows: [string, bigint][] = [
    [bitcoin === 0n ? 'Assets' : 'Other assets', BigInt(worth.otherAssetsChangeCents)],
    ...(bitcoin === 0n ? [] : ([['Bitcoin, at price', bitcoin]] as [string, bigint][])),
    ['Debts paid down', BigInt(worth.debtsPaidDownCents)],
  ];

  return (
    <div className="flex flex-col">
      {rows.map(([name, value]) => (
        <div key={name} className="row-cell flex justify-between border-b border-line">
          <span className="text-ink">{name}</span>
          <span className={`money ${value < 0n ? 'text-ink' : 'text-positive'}`}>
            {formatCents(value, { explicitPlus: true })}
          </span>
        </div>
      ))}
      <div className="row-cell flex justify-between border-t-2 border-ink font-bold">
        <span className="text-ink">Change</span>
        <span className={`money ${change < 0n ? 'text-ink' : 'text-positive'}`}>
          {formatCents(change, { explicitPlus: true })}
        </span>
      </div>
    </div>
  );
}

export function MonthReview(): ReactNode {
  const [params, setParams] = useSearchParams();
  const asked = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month') : null;

  const query = useQuery({
    queryKey: ['month-review', asked],
    queryFn: () => monthReviewApi.get(asked),
  });
  const review = query.data;

  function go(month: string): void {
    const next = new URLSearchParams(params);
    next.set('month', month);
    setParams(next);
  }

  if (query.isError) {
    return (
      <div>
        <PageHeader title="Month in review" />
        <Alert>The month could not be read.</Alert>
      </div>
    );
  }

  if (!review) {
    return (
      <div>
        <PageHeader title="Month in review" />
        <EmptyState>Reading the month…</EmptyState>
      </div>
    );
  }

  const cameIn = BigInt(review.cameInCents);
  const wentOut = BigInt(review.wentOutCents);
  const leftOver = cameIn - wentOut;
  const label = monthName(review.month);
  const before = review.previousMonth ?? review.month;
  const worth = review.netWorth;
  const worthChange = worth === null ? null : BigInt(worth.endCents) - BigInt(worth.startCents);

  return (
    <div>
      <PageHeader
        title={label}
        actions={
          <>
            <Button
              disabled={review.previousMonth === null}
              onClick={() => review.previousMonth !== null && go(review.previousMonth)}
            >
              ‹{' '}
              {review.previousMonth === null
                ? 'Earlier'
                : monthName(review.previousMonth, 'long').split(' ')[0]}
            </Button>
            <Button
              disabled={review.nextMonth === null}
              onClick={() => review.nextMonth !== null && go(review.nextMonth)}
            >
              {review.nextMonth === null
                ? 'Later'
                : monthName(review.nextMonth, 'long').split(' ')[0]}{' '}
              ›
            </Button>
          </>
        }
      />

      <TileGrid>
        <Tile span="full">
          <div className="grid grid-cols-2 gap-6 @lg:grid-cols-4">
            <FigureCell
              label="Came in"
              value={formatCents(cameIn)}
              note={against(
                cameIn,
                review.previous === null ? undefined : BigInt(review.previous.cameInCents),
                before,
              )}
              href={registerHref(
                {
                  kind: 'income',
                  inBudget: true,
                  dateFrom: review.from,
                  dateBefore: review.before,
                },
                { label: `Came in, ${label}`, cents: cameIn },
              )}
            />
            <FigureCell
              label="Went out"
              value={formatCents(wentOut)}
              note={against(
                wentOut,
                review.previous === null ? undefined : BigInt(review.previous.wentOutCents),
                before,
              )}
              href={registerHref(
                {
                  kind: 'normal',
                  inBudget: true,
                  dateFrom: review.from,
                  dateBefore: review.before,
                },
                { label: `Went out, ${label}`, cents: wentOut },
              )}
            />
            <FigureCell
              label="Left over"
              value={formatCents(leftOver, { explicitPlus: true })}
              note={
                cameIn > 0n
                  ? `${Number((leftOver * 100n) / cameIn)}% of what came in`
                  : 'Nothing came in'
              }
              tone={leftOver < 0n ? 'negative' : 'positive'}
            />
            <FigureCell
              label="Net worth"
              value={worthChange === null ? '—' : formatCents(worthChange, { explicitPlus: true })}
              note={
                worth === null
                  ? 'No snapshots for this month yet'
                  : `${formatCents(BigInt(worth.startCents))} → ${formatCents(BigInt(worth.endCents))}`
              }
              tone={worthChange === null || worthChange < 0n ? 'ink' : 'positive'}
            />
          </div>
        </Tile>

        <Tile span="two-thirds" title="Each line, start to end">
          <LinesTable review={review} />
        </Tile>

        <TileColumn span="third">
          <Tile title="Bills that moved">
            {review.bills.length === 0 ? (
              <EmptyState>Every bill came as usual.</EmptyState>
            ) : (
              <ul className="list-none p-0">
                {review.bills.map((bill) => (
                  <BillRow key={bill.key} bill={bill} />
                ))}
              </ul>
            )}
          </Tile>
          <Tile title="What net worth did">
            <NetWorthTile review={review} />
          </Tile>
        </TileColumn>
      </TileGrid>
    </div>
  );
}
