import { formatCents } from '@budget/shared';
import type { ReactNode } from 'react';

/**
 * Where the money came from and where it went.
 *
 * Hand-rolled SVG, like every chart here. `docs/dependencies.md` asks whether
 * the alternative is implementing cryptography or a wire protocol by hand; a
 * Sankey is node stacking and cubic béziers, which is neither. The second reason
 * matters more: every palette in this application is measured by
 * `theme-contrast.test.ts`, and a charting library brings its own colour model —
 * six measured palettes with an unmeasured chart drawn on top of them is worse
 * than no chart.
 *
 * Two things it does that the charts this was modelled on do not.
 *
 * **Anything under 1% of the flow is rolled into `Other`.** In the reference
 * screenshot a $16 healthcare charge against a $29,501 flow is about half a
 * pixel of ribbon, and its label sits on top of the two above it. A ribbon that
 * thin cannot carry a label, so it is grouped and its parts are named on hover.
 *
 * **Every node gets a minimum labelling slot.** The ribbon's thickness stays
 * proportional — that is the whole honesty of the picture — but the space
 * between nodes is allowed to grow so two labels never overlap. Thickness says
 * the amount; spacing is only how the labels fit.
 */

export interface FlowNode {
  readonly key: string;
  readonly name: string;
  readonly amountCents: bigint;
  readonly tone: 'income' | 'uncategorized' | 'surplus' | 'spending';
  /** What was rolled up into this node, for the hover. */
  readonly detail?: string;
}

const TONE: Record<FlowNode['tone'], string> = {
  income: 'var(--color-positive)',
  uncategorized: 'var(--color-warning-dot)',
  surplus: 'var(--color-positive)',
  spending: 'var(--color-accent)',
};

/** design.md's ordered multi-series palette, for the spending side. */
const SPENDING_TOKENS = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
  'var(--color-series-5)',
  'var(--color-series-6)',
  'var(--color-series-7)',
  'var(--color-series-8)',
];

/**
 * How much of a node's name fits beside its bar.
 *
 * SVG text does not wrap and cannot be ellipsised by CSS, so this is measured in
 * characters rather than pixels — an approximation, and a generous one, because
 * the cost of being wrong is a label a little short rather than one running
 * across the ribbons. The whole name is on the hover either way.
 *
 * Four characters shorter since the labels gained a percentage: the line is
 * name, amount, then share, and the name is the part that can afford to give.
 */
const LABEL_MAX = 24;

function truncate(name: string): string {
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}

/**
 * A node's share of the flow, to the nearest whole percent.
 *
 * The ribbon's thickness is the share, but a ribbon is only comparable against
 * the ones beside it — the figure says how big a piece of the whole this is,
 * which is the question somebody actually has of a cashflow chart. Integer
 * arithmetic on cents, rounded rather than truncated, so a node at 7.6% does not
 * read as 7.
 */
function share(amountCents: bigint, total: bigint): string {
  if (total <= 0n) return '';
  // Tenths of a percent in integer cents, then rounded to whole percent.
  const tenths = Number((amountCents * 1000n) / total);
  return tenths < 5 ? '<1%' : `${Math.round(tenths / 10)}%`;
}

const WIDTH = 1000;
/** Pixels of bar for the whole flow. One scale, both sides. */
const BARS = 360;
const BAR_W = 12;
const GAP = 8;
/** The least vertical room a node needs for its label not to touch the next. */
const MIN_SLOT = 22;
const TOP = 24;

interface Laid extends FlowNode {
  readonly y: number;
  readonly h: number;
  readonly color: string;
}

/**
 * Rolls everything under `share` of the total into one node.
 *
 * **Uncategorized is never rolled up, whatever its size.** It is the one node on
 * this chart somebody can act on, and until it is worked every other figure here
 * is wrong by whatever it holds — so hiding it inside `Other` because it happens
 * to be small is precisely backwards. Found with $1,048 of a real year's
 * uncategorized income filed under `Other (8)`.
 */
function rollUp(nodes: readonly FlowNode[], total: bigint, share: number): FlowNode[] {
  if (total <= 0n) return [];
  const keep: FlowNode[] = [];
  const small: FlowNode[] = [];
  for (const node of nodes) {
    if (node.tone === 'uncategorized') {
      keep.push(node);
      continue;
    }
    // Integer comparison: value * 1000 against total * (share * 1000).
    const thousandths = Number((node.amountCents * 1000n) / total);
    (thousandths < share * 1000 ? small : keep).push(node);
  }
  keep.sort((a, b) => (b.amountCents > a.amountCents ? 1 : b.amountCents < a.amountCents ? -1 : 0));

  if (small.length === 1) keep.push(small[0]!);
  else if (small.length > 1) {
    keep.push({
      key: '__other',
      name: `Other (${small.length})`,
      amountCents: small.reduce((sum, node) => sum + node.amountCents, 0n),
      tone: small[0]!.tone,
      detail: small.map((node) => `${node.name} ${formatCents(node.amountCents)}`).join(' · '),
    });
  }
  return keep;
}

function stack(
  nodes: readonly FlowNode[],
  perCent: number,
  colorAt: (index: number) => string,
): { laid: Laid[]; height: number } {
  let y = 0;
  const laid: Laid[] = nodes.map((node, index) => {
    const h = Math.max(Number(node.amountCents) * perCent, 1.5);
    const entry: Laid = { ...node, y, h, color: colorAt(index) };
    // The bar is proportional; the *slot* has a floor, so two labels never touch.
    y += Math.max(h, MIN_SLOT) + GAP;
    return entry;
  });
  return { laid, height: Math.max(y - GAP, 0) };
}

function ribbon(x0: number, y0: number, x1: number, y1: number, thickness: number): string {
  const mid = (x0 + x1) / 2;
  return [
    `M${x0.toFixed(2)},${y0.toFixed(2)}`,
    `C${mid.toFixed(2)},${y0.toFixed(2)} ${mid.toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`,
    `L${x1.toFixed(2)},${(y1 + thickness).toFixed(2)}`,
    `C${mid.toFixed(2)},${(y1 + thickness).toFixed(2)} ${mid.toFixed(2)},${(y0 + thickness).toFixed(2)} ${x0.toFixed(2)},${(y0 + thickness).toFixed(2)}`,
    'Z',
  ].join(' ');
}

export function Sankey({
  inflows,
  outflows,
  emptyMessage,
}: {
  readonly inflows: readonly FlowNode[];
  readonly outflows: readonly FlowNode[];
  readonly emptyMessage: string;
}): ReactNode {
  const total = inflows.reduce((sum, node) => sum + node.amountCents, 0n);
  if (total <= 0n) {
    return <p className="text-quiet text-muted">{emptyMessage}</p>;
  }

  const left = rollUp(inflows, total, 0.01);
  const right = rollUp(outflows, total, 0.01);

  // One scale for both sides, so the middle bar is exactly each column's sum.
  const perCent = BARS / Number(total);

  const leftStack = stack(left, perCent, () => '');
  const rightStack = stack(right, perCent, (index) => SPENDING_TOKENS[index % 8] ?? '');

  const tallest = Math.max(leftStack.height, rightStack.height, BARS);
  const height = tallest + TOP * 2;

  const leftX = 8;
  const midX = 470;
  const rightX = WIDTH - 8 - BAR_W;
  const leftTop = TOP + (tallest - leftStack.height) / 2;
  const rightTop = TOP + (tallest - rightStack.height) / 2;
  const midTop = TOP + (tallest - BARS) / 2;

  const colorOf = (node: Laid): string =>
    node.tone === 'spending' ? node.color || TONE.spending : TONE[node.tone];

  const ribbons: ReactNode[] = [];
  let cursor = midTop;
  for (const node of leftStack.laid) {
    ribbons.push(
      <path
        key={`in-${node.key}`}
        d={ribbon(leftX + BAR_W, leftTop + node.y, midX, cursor, node.h)}
        style={{ fill: colorOf(node), fillOpacity: 0.26 }}
      >
        <title>{`${node.name} — ${formatCents(node.amountCents)} · ${share(node.amountCents, total)} of the flow${node.detail ? ` · ${node.detail}` : ''}`}</title>
      </path>,
    );
    cursor += node.h;
  }
  cursor = midTop;
  for (const node of rightStack.laid) {
    ribbons.push(
      <path
        key={`out-${node.key}`}
        d={ribbon(midX + BAR_W, cursor, rightX, rightTop + node.y, node.h)}
        style={{ fill: colorOf(node), fillOpacity: 0.26 }}
      >
        <title>{`${node.name} — ${formatCents(node.amountCents)} · ${share(node.amountCents, total)} of the flow${node.detail ? ` · ${node.detail}` : ''}`}</title>
      </path>,
    );
    cursor += node.h;
  }

  return (
    /*
     * `min-h-0` so this can be shorter than the drawing inside it. A flex item's
     * minimum size is its content, which would keep the chart at full height and
     * push it out of a row somebody had just dragged shorter.
     */
    <div className="h-full min-h-0 w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        /*
         * It scales to the room it is given rather than scrolling inside it.
         *
         * `max-height: 100%` against a tile whose height was dragged, capped at
         * 520px where nothing constrains it — the drawing scales with its width
         * and the page got 400px wider, so the chart that fitted a screen at
         * 1200px ran off the bottom of one at 1600.
         *
         * The default `xMidYMid meet` keeps the proportions and centres what is
         * left, so a shorter row shrinks the flow rather than cropping it.
         */
        className="block w-full min-w-[640px]"
        role="img"
        aria-label={`Cashflow: ${formatCents(total)} from ${left.length} sources to ${right.length} destinations`}
        /*
         * `height: 100%` with a pixel cap, which covers both cases with one
         * rule: in a row whose height was dragged the chain is definite and this
         * fills it, and where nothing constrains it the percentage goes
         * indefinite, the drawing takes its intrinsic height, and the cap brings
         * it back to 520.
         *
         * `min(520px, 100%)` was the first attempt and silently lost the cap —
         * a `min()` containing an indefinite percentage is itself indefinite,
         * so an unconstrained chart went back to 780px.
         */
        style={{ height: '100%', maxHeight: 520, fontVariantNumeric: 'tabular-nums' }}
      >
        {/* Ribbons first, so labels sit over them rather than under. */}
        {ribbons}

        {leftStack.laid.map((node) => (
          <rect
            key={`lb-${node.key}`}
            x={leftX}
            y={leftTop + node.y}
            width={BAR_W}
            height={node.h}
            rx="2"
            style={{ fill: colorOf(node) }}
          />
        ))}
        {rightStack.laid.map((node) => (
          <rect
            key={`rb-${node.key}`}
            x={rightX}
            y={rightTop + node.y}
            width={BAR_W}
            height={node.h}
            rx="2"
            style={{ fill: colorOf(node) }}
          />
        ))}
        <rect
          x={midX}
          y={midTop}
          width={BAR_W}
          height={BARS}
          rx="2"
          style={{ fill: 'var(--color-accent)' }}
        />

        {/* One line each — name then figure. The reference chart put them on two
            lines and they collided; this cannot, whatever the node's height. */}
        {leftStack.laid.map((node) => (
          <text
            key={`lt-${node.key}`}
            x={leftX + BAR_W + 10}
            y={leftTop + node.y + node.h / 2}
            dominantBaseline="middle"
            fontSize="13"
            fontWeight="600"
            style={{ fill: 'var(--color-ink)' }}
          >
            {truncate(node.name)}{' '}
            <tspan fontWeight="400" style={{ fill: 'var(--color-muted)' }}>
              {formatCents(node.amountCents)}
            </tspan>{' '}
            <tspan fontWeight="400" style={{ fill: 'var(--color-axis)' }}>
              {share(node.amountCents, total)}
            </tspan>
            <title>{`${node.name} — ${formatCents(node.amountCents)} · ${share(node.amountCents, total)} of the flow`}</title>
          </text>
        ))}
        {rightStack.laid.map((node) => (
          <text
            key={`rt-${node.key}`}
            x={rightX - 10}
            y={rightTop + node.y + node.h / 2}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize="13"
            fontWeight="600"
            style={{ fill: 'var(--color-ink)' }}
          >
            {truncate(node.name)}{' '}
            <tspan fontWeight="400" style={{ fill: 'var(--color-muted)' }}>
              {formatCents(node.amountCents)}
            </tspan>{' '}
            <tspan fontWeight="400" style={{ fill: 'var(--color-axis)' }}>
              {share(node.amountCents, total)}
            </tspan>
            <title>{`${node.name} — ${formatCents(node.amountCents)} · ${share(node.amountCents, total)} of the flow`}</title>
          </text>
        ))}
        <text
          x={midX + BAR_W / 2}
          y={midTop - 8}
          textAnchor="middle"
          fontSize="11"
          fontWeight="600"
          letterSpacing="0.05em"
          style={{ fill: 'var(--color-muted)' }}
        >
          {formatCents(total)}
        </text>
      </svg>
    </div>
  );
}
