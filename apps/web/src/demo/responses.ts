import {
  GROUPINGS,
  LINES,
  balances,
  daysAgo,
  history,
  payDays,
  perCycleFor,
  waitingToDelegate,
} from './household.js';

/**
 * What the server would have said, if the household were real.
 *
 * One function per endpoint the demo pages ask for, each returning exactly the
 * shape that endpoint returns — because the whole trick here is that **the pages
 * do not know**. They are the same components, running the same queries, drawing
 * whatever comes back. Nothing is branched on being a demo except the single
 * `fetch` these answer in place of.
 *
 * Money is decimal strings over the wire (ADR 002), so every figure here is
 * stringified from integer cents exactly as the API does it.
 */

const cents = (value: number): string => String(Math.round(value));
const iso = (at: Date): string => at.toISOString();

/** Midnight UTC standing for a local calendar day, as the API's day keys are. */
function dayKey(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(
    at.getDate(),
  ).padStart(2, '0')}T00:00:00.000Z`;
}

const groupingOf = (lineId: string): (typeof GROUPINGS)[number] => {
  const line = LINES.find((entry) => entry.id === lineId);
  return GROUPINGS.find((group) => group.key === line?.grouping) ?? GROUPINGS[0];
};

/** The pay cycle the household is in, and how far through it. */
function payCycle(): Record<string, unknown> {
  const days = payDays();
  const start = days[days.length - 1] ?? daysAgo(5);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 14);

  const elapsed = Math.max(0, Math.round((daysAgo(0).getTime() - start.getTime()) / 86_400_000));
  return {
    start: iso(start),
    end: iso(end),
    lengthDays: 14,
    elapsedDays: elapsed,
    progressBasisPoints: Math.round((elapsed / 14) * 10_000),
  };
}

/** Spending since the current cycle began, by whichever cut is asked for. */
function spending(by: 'grouping' | 'delegation'): Record<string, unknown> {
  const days = payDays();
  const since = days[days.length - 1] ?? daysAgo(14);
  const totals = new Map<string, { name: string; color: string | null; spent: number }>();

  for (const row of history()) {
    if (row.kind !== 'normal' || row.line === null || row.at < since) continue;
    const group = groupingOf(row.line);
    const line = LINES.find((entry) => entry.id === row.line);
    const key = by === 'grouping' ? group.key : row.line;
    const name = by === 'grouping' ? group.name : (line?.name ?? row.line);
    const existing = totals.get(key);
    totals.set(key, {
      name,
      color: group.color,
      spent: (existing?.spent ?? 0) - row.cents,
    });
  }

  return {
    cycleMissing: false,
    entries: [...totals.entries()]
      .map(([key, entry]) => ({
        key,
        name: entry.name,
        color: entry.color,
        spendCents: cents(entry.spent),
      }))
      .sort((a, b) => Number(b.spendCents) - Number(a.spendCents)),
  };
}

/** One calendar month of the outflow band. */
function outflowMonth(monthsBack: number): Record<string, unknown> {
  const now = daysAgo(0);
  const first = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1, 12);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();

  const spentOn = new Map<number, number>();
  for (const row of history()) {
    if (row.kind !== 'normal') continue;
    if (row.at.getFullYear() !== first.getFullYear() || row.at.getMonth() !== first.getMonth()) {
      continue;
    }
    spentOn.set(row.at.getDate(), (spentOn.get(row.at.getDate()) ?? 0) - row.cents);
  }

  return {
    month: dayKey(first),
    days: Array.from({ length: last }, (_unused, index) => {
      const at = new Date(first.getFullYear(), first.getMonth(), index + 1, 12);
      return { date: dayKey(at), spentCents: cents(spentOn.get(index + 1) ?? 0) };
    }),
  };
}

/** The panel's lines: what each holds, what it is funded at, what it spent. */
function panel(): Record<string, unknown>[] {
  const held = balances();
  const days = payDays();
  const since = days[days.length - 1] ?? daysAgo(14);

  const spent = new Map<string, number>();
  for (const row of history()) {
    if (row.kind !== 'normal' || row.line === null || row.at < since) continue;
    spent.set(row.line, (spent.get(row.line) ?? 0) - row.cents);
  }

  return LINES.map((line) => {
    const group = groupingOf(line.id);
    return {
      id: line.id,
      name: line.name,
      groupingId: group.key,
      groupingName: group.name,
      color: group.color,
      balanceCents: cents(held.get(line.id) ?? 0),
      plannedCents: cents(perCycleFor(line.id)),
      spentCents: cents(spent.get(line.id) ?? 0),
    };
  });
}

/** Where the money is, and where it is meant to go. */
function allocation(): Record<string, unknown> {
  const held = balances();
  const sum = (pick: (line: (typeof LINES)[number]) => number): Record<string, unknown>[] => {
    const totals = new Map<string, number>();
    for (const line of LINES) {
      const group = groupingOf(line.id);
      totals.set(group.key, (totals.get(group.key) ?? 0) + Math.max(pick(line), 0));
    }
    return [...totals.entries()]
      .map(([key, amount]) => ({
        key,
        name: GROUPINGS.find((group) => group.key === key)?.name ?? key,
        color: GROUPINGS.find((group) => group.key === key)?.color ?? null,
        amountCents: cents(amount),
      }))
      .filter((slice) => Number(slice.amountCents) > 0)
      .sort((a, b) => Number(b.amountCents) - Number(a.amountCents));
  };

  return {
    plan: sum((line) => perCycleFor(line.id)),
    position: sum((line) => held.get(line.id) ?? 0),
  };
}

/** Money in against money out, over the window the chart is showing. */
function cashflow(): Record<string, unknown> {
  const since = daysAgo(365);
  let income = 0;
  const out = new Map<string, number>();

  for (const row of history()) {
    if (row.at < since) continue;
    if (row.kind === 'income') {
      income += row.cents;
      continue;
    }
    if (row.line === null) continue;
    const group = groupingOf(row.line);
    out.set(group.key, (out.get(group.key) ?? 0) - row.cents);
  }

  const spent = [...out.values()].reduce((total, amount) => total + amount, 0);
  return {
    cycleMissing: false,
    inflows: [{ key: 'income', name: 'Income', amountCents: cents(income) }],
    outflows: [...out.entries()].map(([key, amount]) => ({
      key,
      name: GROUPINGS.find((group) => group.key === key)?.name ?? key,
      amountCents: cents(amount),
    })),
    uncategorizedInCents: '0',
    uncategorizedOutCents: '0',
    surplusCents: cents(Math.max(income - spent, 0)),
  };
}

/** The arrangement the demo opens on. Nobody can change it, so it is chosen. */
function layout(): Record<string, unknown> {
  const tiles: [string, 'main' | 'sidebar', number, number][] = [
    ['spending_by_grouping', 'main', 0, 0],
    ['spending_by_delegation', 'main', 0, 1],
    ['allocation', 'main', 0, 2],
    ['cashflow', 'main', 1, 0],
    ['delegations', 'main', 2, 0],
    ['daily_outflow', 'sidebar', 0, 0],
    ['delegations_negative', 'sidebar', 1, 0],
  ];

  return {
    catalog: tiles.map(([key]) => key),
    columns: 12,
    maxPerRow: 3,
    tiles: tiles.map(([key, region, row, position]) => ({
      key,
      region,
      row,
      position,
      heightPx: null,
      display: null,
      config: key === 'delegations' ? { delegationIds: LINES.map((line) => line.id) } : null,
    })),
  };
}

/** Every line that is over-spent, worst first. */
function negative(): Record<string, unknown>[] {
  const held = balances();
  return LINES.filter((line) => (held.get(line.id) ?? 0) < 0)
    .map((line) => ({
      id: line.id,
      name: line.name,
      balanceCents: cents(held.get(line.id) ?? 0),
    }))
    .sort((a, b) => Number(a.balanceCents) - Number(b.balanceCents));
}

/**
 * The answer for one path, or `undefined` where the demo has nothing to say.
 *
 * Undefined matters: it means "let this one through to the server", which is
 * what the session and the application's own name should do. The demo is
 * invented *money*, not an invented account.
 */
export function demoResponse(path: string): unknown {
  const [route] = path.split('?');

  if (route === '/api/overview/layout') return layout();

  if (route === '/api/overview' || route === '/api/overview/preview') {
    return {
      window: 'cycle',
      spending_by_grouping: spending('grouping'),
      spending_by_delegation: spending('delegation'),
      allocation: allocation(),
      cashflow: cashflow(),
      cashflowWindow: '1yr',
      daily_outflow: [outflowMonth(0), outflowMonth(1), outflowMonth(2)],
      delegations_negative: negative(),
      panel: panel(),
      payCycle: payCycle(),
    };
  }

  return undefined;
}

/** What the Budget page reads. Exported so the page can be shown too. */
export function demoBudget(): Record<string, unknown> {
  const held = balances();
  const delegated = [...held.values()].reduce((total, amount) => total + amount, 0);
  const waiting = waitingToDelegate();

  return {
    assets: {
      groupings: [
        {
          id: 'accounts',
          name: 'Accounts',
          color: null,
          collapsed: false,
          rows: [
            {
              id: 'checking',
              name: 'Everyday Checking',
              kind: 'account',
              balanceCents: cents(delegated + waiting),
              amountToDelegateCents: null,
            },
          ],
        },
      ],
      ungrouped: [],
      totalCents: cents(delegated + waiting),
    },
    debts: { groupings: [], ungrouped: [], totalCents: '0' },
    delegations: {
      groupings: GROUPINGS.map((group) => ({
        id: group.key,
        name: group.name,
        color: group.color,
        collapsed: false,
        rows: LINES.filter((line) => line.grouping === group.key).map((line) => ({
          id: line.id,
          name: line.name,
          kind: 'delegation',
          balanceCents: cents(held.get(line.id) ?? 0),
          amountToDelegateCents: cents(perCycleFor(line.id)),
        })),
      })),
      ungrouped: [],
      totalCents: cents(delegated),
    },
    identity: { differenceCents: cents(waiting), balanced: waiting === 0 },
    cycleStartedAt: iso(payDays()[payDays().length - 2] ?? daysAgo(19)),
  };
}
