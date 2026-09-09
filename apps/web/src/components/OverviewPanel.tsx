import { formatCents } from '@budget/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { accountsApi, type AccountDto } from '../api/accounts.js';
import type { OverviewDataDto, PanelLineDto } from '../api/overview.js';
import { EmptyState, SegmentedControl } from './layout.jsx';
import { PaceBar, paceSummary } from './PaceBar.jsx';
import { Button } from './ui.jsx';

/**
 * The budget, docked beside the dashboard.
 *
 * Three tabs, and they are three tabs rather than three tiles because they
 * answer the questions somebody keeps coming back to while reading everything
 * else: what is left in the lines I watch, what is in the accounts, what is
 * still owed. A tile can be scrolled past. This cannot.
 *
 * **It is not the Budget page and does not replace it.** Budget stays the
 * working surface — row menus, transfers, manual adjustment, reordering. This
 * is a reading. The two draw from the same figures, so they can differ in
 * presentation and never in arithmetic.
 *
 * On a phone there is no room to dock anything 398px wide beside anything else,
 * so the same three tabs are promoted onto the page itself and Overview becomes
 * the fourth. `variant` is which of those two shapes is being drawn; everything
 * inside is identical, because a second implementation is how two surfaces come
 * to disagree.
 */

export type PanelTab = 'delegations' | 'accounts' | 'debts';

const TABS = [
  { value: 'delegations' as const, label: 'Delegations' },
  { value: 'accounts' as const, label: 'Accounts' },
  { value: 'debts' as const, label: 'Debts' },
];

export function OverviewPanel({
  variant,
  tab,
  onTab,
  data,
  onChoose,
  onCollapse,
}: {
  readonly variant: 'docked' | 'inline';
  readonly tab: PanelTab;
  readonly onTab: (next: PanelTab) => void;
  readonly data: OverviewDataDto | undefined;
  readonly onChoose: () => void;
  /** Only the docked panel collapses; inline is already the whole width. */
  readonly onCollapse?: () => void;
}): ReactNode {
  /*
   * Keys 1–3, as the design specifies. Bound on the document rather than the
   * panel so they work before anything inside has been focused — and ignored
   * while a field has focus, because a keystroke inside a form field belongs to
   * the field. That rule is already the register's; breaking it here would mean
   * typing a delegation name jumped tabs.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const index = ['1', '2', '3'].indexOf(event.key);
      if (index >= 0) onTab(TABS[index]!.value);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onTab]);

  const body =
    tab === 'delegations' ? (
      <DelegationsTab data={data} onChoose={onChoose} />
    ) : (
      <BalancesTab kind={tab} />
    );

  if (variant === 'inline') return body;

  return (
    <aside
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-canvas"
      aria-label="Budget"
    >
      <div className="flex items-center gap-2 border-b border-line p-3">
        <SegmentedControl size="sm" label="Panel" value={tab} options={TABS} onChange={onTab} />
        {onCollapse !== undefined && (
          <Button variant="ghost" onClick={onCollapse} aria-label="Collapse the budget panel">
            ›
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      {/* The keyboard map, always visible. A shortcut nobody can see is a
          shortcut nobody uses. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line p-3 text-micro text-muted">
        <Key>1</Key>
        <Key>2</Key>
        <Key>3</Key>
        <span>tabs</span>
      </div>
    </aside>
  );
}

function Key({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <kbd className="rounded border border-line border-b-2 px-1 font-mono text-micro text-muted">
      {children}
    </kbd>
  );
}

/** The pay-cycle strip: where the household is between one payday and the next. */
function CycleStrip({ cycle }: { readonly cycle: OverviewDataDto['payCycle'] }): ReactNode {
  if (!cycle) {
    // No anchor set. Said plainly rather than drawing an empty bar, because an
    // empty progress bar reads as "nothing has happened yet".
    return (
      <p className="border-b border-line p-3 text-quiet text-muted">
        Set your next payday on Settings → Budget to see cycle pace.
      </p>
    );
  }

  const percent = Math.round((cycle.progressBasisPoints / 10_000) * 100);
  const from = new Date(cycle.start).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const to = new Date(cycle.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="border-b border-line p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-micro font-semibold tracking-[0.06em] text-muted uppercase">
          Pay cycle · {from}–{to}
        </span>
        <span className="text-micro text-muted">
          day {cycle.elapsedDays} of {cycle.lengthDays} · {percent}% through
        </span>
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded bg-surface-2">
        <div className="h-full rounded bg-axis" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function DelegationsTab({
  data,
  onChoose,
}: {
  readonly data: OverviewDataDto | undefined;
  readonly onChoose: () => void;
}): ReactNode {
  const lines = data?.panel ?? [];
  const tick = data?.payCycle?.progressBasisPoints ?? null;

  const planned = lines.reduce((sum, line) => sum + BigInt(line.plannedCents ?? '0'), 0n);
  const spent = lines.reduce((sum, line) => sum + BigInt(line.spentCents), 0n);
  const held = lines.reduce((sum, line) => sum + BigInt(line.balanceCents), 0n);

  // Grouped in the order the server sent, which is the Budget page's own.
  const groups: { name: string | null; lines: PanelLineDto[] }[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last.name === line.groupingName) last.lines.push(line);
    else groups.push({ name: line.groupingName, lines: [line] });
  }

  return (
    <div className="flex min-h-0 flex-col">
      <CycleStrip cycle={data?.payCycle ?? null} />

      {lines.length > 0 && (
        /* Budgeted, spent, remaining — the words the household uses. "Held" was
           mine and read as jargon, and "planned" said something the amount to
           delegate does not quite mean. */
        <div className="grid grid-cols-3 border-b border-line">
          <Stat label="Budgeted" value={formatCents(planned)} />
          <Stat label="Spent" value={formatCents(spent)} />
          <Stat
            label="Remaining"
            value={formatCents(held)}
            tone={held < 0n ? 'negative' : undefined}
          />
        </div>
      )}

      <div className="min-h-0 flex-1">
        {lines.length === 0 ? (
          <div className="p-3">
            <EmptyState>No delegations chosen yet.</EmptyState>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.name ?? '__none'}>
              <h3 className="border-t border-line bg-surface px-3 py-1 text-micro font-semibold tracking-[0.06em] text-muted uppercase">
                {group.name ?? 'No grouping'}
              </h3>
              <ul className="list-none p-0">
                {group.lines.map((line) => (
                  <Row key={line.id} line={line} tick={tick} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <div className="border-t border-line p-3">
        <button type="button" className="linkish" onClick={onChoose}>
          Choose which delegations show →
        </button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'negative' | undefined;
}): ReactNode {
  /*
   * Both lines right-aligned, so the label sits over its own figure.
   *
   * They were a left-aligned label above a right-aligned number in a flexed
   * cell, which put "BUDGETED" at one end of the column and $2,499.06 at the
   * other — three pairs that each read as two unrelated things.
   */
  return (
    <div className="flex flex-col items-end gap-1 p-3">
      <span className="text-micro font-semibold tracking-[0.07em] text-muted uppercase">
        {label}
      </span>
      <span
        className={`money text-base font-semibold ${tone === 'negative' ? 'text-negative' : 'text-ink'}`}
      >
        {value}
      </span>
    </div>
  );
}

function Row({
  line,
  tick,
}: {
  readonly line: PanelLineDto;
  readonly tick: number | null;
}): ReactNode {
  const spent = BigInt(line.spentCents);
  const planned = BigInt(line.plannedCents ?? '0');
  const balance = BigInt(line.balanceCents);
  const summary = paceSummary({
    spentCents: spent,
    plannedCents: planned,
    balanceCents: balance,
  });

  return (
    <li className="row-cell flex items-center gap-2 px-3 hover:bg-surface">
      <span className="w-32 shrink-0 truncate text-quiet font-medium text-ink" title={line.name}>
        {line.name}
      </span>
      {/*
        Spent-against-available lives on the bar rather than beside it.

        Three money columns on a 400px panel left the name truncated to about ten
        characters — "Kenzie Perso…", "Medical Spen…" — to make room for a pair
        of figures that is the bar's own subject. The bar says the ratio; hovering
        it says the amounts and what carried in, rounded to the dollar because
        cents are noise in a comparison. What stays in the column is the one
        figure somebody reads to decide anything: what is left.
      */}
      <span className="min-w-0 flex-1" title={summary}>
        <PaceBar
          spentCents={spent}
          plannedCents={planned}
          balanceCents={balance}
          color={line.color}
          cycleProgressBasisPoints={tick}
          label={`${line.name}: ${summary}`}
        />
      </span>
      <span
        className={`money w-20 shrink-0 text-quiet font-semibold ${balance < 0n ? 'text-negative' : 'text-ink'}`}
      >
        {formatCents(balance)}
      </span>
    </li>
  );
}

/**
 * Accounts and Debts: balances only, and **only what the budget counts**.
 *
 * `in_budget` decides which accounts the identity sums, and ADR 050 made that a
 * wall rather than a description after three places crossed it. This panel is
 * the budget's, so it stands on the same side of that wall: a property and a
 * retirement account are net worth, not money this budget can allocate, and
 * listing them here put $350,000 of house in a column headed by what the
 * household can spend.
 *
 * They have not gone anywhere — the composition tile beside this one is net
 * worth's own reading and shows the property at equity, which is the figure
 * design.md specifies for it.
 */
function BalancesTab({ kind }: { readonly kind: 'accounts' | 'debts' }): ReactNode {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  const wanted = (accounts.data?.accounts ?? []).filter(
    (account: AccountDto) =>
      account.archivedAt === null &&
      account.inBudget &&
      account.type === (kind === 'debts' ? 'debt' : 'asset'),
  );

  const total = wanted.reduce((sum, account) => sum + BigInt(account.balanceCents), 0n);

  if (accounts.isPending) return null;
  if (wanted.length === 0) {
    return (
      <div className="p-3">
        <EmptyState>
          {kind === 'debts' ? 'No debts in the budget.' : 'No accounts in the budget.'}
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      <ul className="list-none p-0">
        {wanted.map((account) => {
          const balance = BigInt(account.balanceCents);
          return (
            <li key={account.id} className="row-cell flex items-center gap-2 px-3">
              <span className="min-w-0 flex-1 truncate text-quiet text-ink">
                {account.nickname ?? account.name}
              </span>
              {/* Cents here, unlike the dense rows above: this is a balance
                  list, and a balance is read against a statement. */}
              <span
                className={`money shrink-0 text-quiet font-semibold ${balance === 0n ? 'text-muted' : 'text-ink'}`}
              >
                {formatCents(balance)}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-line bg-surface px-3 py-2 text-quiet font-semibold">
        <span>{kind === 'debts' ? 'Debts in the budget' : 'Accounts in the budget'}</span>
        <span className="money">{formatCents(total)}</span>
      </div>
      {/* Said plainly, because a total that silently excluded a $350,000 house
          would be a number somebody trusts and should not. */}
      <p className="p-3 text-micro text-muted">
        Balances only · what the budget counts, not net worth.
      </p>
    </div>
  );
}
