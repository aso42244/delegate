import { formatCents } from '@budget/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';

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
const TOP = 24;

/**
 * The viewBox height used when nothing constrains this chart.
 *
 * Everything below is in viewBox user units. The viewBox is a fixed 1000 units
 * wide and the element is always the full width of its tile, so one unit is a
 * constant number of pixels and the drawing never has to be scaled to fit — it
 * is *laid out* to fit, which is what keeps the type one size as the tile grows.
 */
const ROOM = 408;

/**
 * Below this the arithmetic stops meaning anything.
 *
 * Low on purpose. A row dragged to the bottom of its range draws a smear, and
 * that is the trade asked for: the whole chart inside the tile matters more than
 * any of it being readable.
 */
const MIN_ROOM = 24;

/**
 * The height to draw into, for a box of a given shape.
 *
 * Converts the pixels the tile has into the units the viewBox measures width in.
 * The result becomes the viewBox height exactly, so the drawing's own height in
 * pixels comes back to the number that went in and nothing is ever clipped.
 */
function roomFor(width: number, heightPx: number | null): number {
  // Only an *absent* height falls back to the default. A height that is merely
  // very small is an answer, and treating it as no answer made the shortest
  // rows jump back to a full-size chart.
  if (width === 0 || heightPx === null) return ROOM;
  return Math.max(MIN_ROOM, (heightPx * WIDTH) / width);
}

const BAR_W = 12;
const GAP = 8;
/** The least vertical room a node needs for its label not to touch the next. */
const MIN_SLOT = 22;

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
  slot: number,
  gap: number,
  colorAt: (index: number) => string,
): { laid: Laid[]; height: number } {
  let y = 0;
  const laid: Laid[] = nodes.map((node, index) => {
    const h = Math.max(Number(node.amountCents) * perCent, 1.5);
    const entry: Laid = { ...node, y, h, color: colorAt(index) };
    // The bar is proportional; the *slot* has a floor, so two labels never touch.
    y += Math.max(h, slot) + gap;
    return entry;
  });
  return { laid, height: Math.max(y - gap, 0) };
}

/** What a column of nodes comes to at a given scale, gaps and floors included. */
function stackHeight(
  nodes: readonly FlowNode[],
  perCent: number,
  slot: number,
  gap: number,
): number {
  if (nodes.length === 0) return 0;
  let height = gap * (nodes.length - 1);
  for (const node of nodes) height += Math.max(Number(node.amountCents) * perCent, slot);
  return height;
}

/**
 * How much to shrink the furniture — slot floors, gaps, type — to fit `drawing`.
 *
 * A column of eight nodes needs eight slot floors and seven gaps whatever the
 * amounts are, and below some height that alone is taller than the tile. The
 * chart is asked to fit the window rather than stay legible, so the furniture
 * gives way: 1 where there is room, and proportionally less where there is not.
 */
function furnitureFit(counts: readonly number[], drawing: number): number {
  const needed = Math.max(
    ...counts.map((count) => (count === 0 ? 0 : MIN_SLOT * count + GAP * (count - 1))),
  );
  return needed <= 0 ? 1 : Math.min(1, drawing / needed);
}

/**
 * The largest scale at which every column still fits the height available.
 *
 * Found by bisection rather than arithmetic, because a column's height is not
 * linear in the scale: a node whose ribbon is thinner than the slot floor stops
 * contributing as the scale falls, so there is no closed form to rearrange. The
 * height is monotonic in the scale, though, which is all bisection needs.
 *
 * This is the fix for a chart that was reliably too tall for its tile. The scale
 * used to be set from the middle bar alone, and every column then added its gaps
 * and floors on top — about 56 units of overflow for eight nodes, clipped off the
 * bottom of the tile at every size.
 */
function scaleToFit(
  sides: readonly (readonly FlowNode[])[],
  total: bigint,
  drawing: number,
  slot: number,
  gap: number,
): number {
  let low = 0;
  let high = drawing / Number(total);
  for (let step = 0; step < 40; step += 1) {
    const mid = (low + high) / 2;
    if (sides.every((nodes) => stackHeight(nodes, mid, slot, gap) <= drawing)) low = mid;
    else high = mid;
  }
  return low;
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
  heightPx,
}: {
  readonly inflows: readonly FlowNode[];
  readonly outflows: readonly FlowNode[];
  readonly emptyMessage: string;
  /**
   * How tall to draw, in pixels — the height of the row this sits in.
   *
   * Absent where nothing constrains it, and then the chart takes its own
   * default. **Given rather than measured**, and that is the point: the height
   * of the box this is drawn into depends on what is drawn into it, so reading
   * it back and laying out to it is a loop. It ran to 3,883px.
   */
  readonly heightPx?: number | undefined;
}): ReactNode {
  /*
   * How wide the chart is, measured. How tall it should be, given.
   *
   * **Only the width is observed**, and that asymmetry is the whole of this.
   * The element is the full width of its tile whatever is drawn inside it, so
   * measuring the width is safe. The height is not: it comes from the drawing,
   * so measuring it and then laying out to it feeds back — a taller chart makes
   * a taller box makes a taller chart.
   *
   * The height comes from `heightPx` instead, from the row that actually knows,
   * because somebody dragged it.
   *
   * 0 until the first measurement, and `barsFor` falls back to the default for
   * that one frame.
   */
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      // Rounded, so a sub-pixel reflow does not redraw the whole chart.
      const measured = Math.round(entry.contentRect.width);
      setWidth((was) => (was === measured ? was : measured));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const total = inflows.reduce((sum, node) => sum + node.amountCents, 0n);
  if (total <= 0n) {
    return <p className="text-quiet text-muted">{emptyMessage}</p>;
  }

  const left = rollUp(inflows, total, 0.01);
  const right = rollUp(outflows, total, 0.01);

  /*
   * The whole drawing is fitted to the room, in this order:
   *
   *   1. the room, in user units — this becomes the viewBox height exactly, so
   *      the chart's height in pixels is the height it was given;
   *   2. headroom for the total above the middle bar, which gives way first;
   *   3. how far the furniture has to shrink for the columns to fit at all;
   *   4. the largest scale at which they actually do.
   *
   * Nothing is scaled afterwards. `preserveAspectRatio` would move both
   * dimensions together, which is what used to make a shorter row draw a
   * narrower chart inside a tile that was exactly as wide as before.
   */
  const height = roomFor(width, heightPx ?? null);
  const top = Math.min(TOP, height * 0.06);
  const drawing = Math.max(height - top * 2, 1);

  const fit = furnitureFit([left.length, right.length], drawing);
  const slot = MIN_SLOT * fit;
  const gap = GAP * fit;

  // One scale for both sides, so the middle bar is exactly each column's sum.
  const perCent = scaleToFit([left, right], total, drawing, slot, gap);

  const leftStack = stack(left, perCent, slot, gap, () => '');
  const rightStack = stack(right, perCent, slot, gap, (index) => SPENDING_TOKENS[index % 8] ?? '');

  const bars = Number(total) * perCent;

  const leftX = 8;
  const midX = 470;
  const rightX = WIDTH - 8 - BAR_W;
  const leftTop = top + (drawing - leftStack.height) / 2;
  const rightTop = top + (drawing - rightStack.height) / 2;
  const midTop = top + (drawing - bars) / 2;

  /* Type is furniture too. Held at 4 units at the bottom: past that it is a
     smudge, and a smudge that still says where the labels are is worth more
     than nothing at all. */
  const labelSize = Math.max(13 * fit, 4);
  const totalSize = Math.max(11 * fit, 4);

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
    <div ref={box} className="h-full min-h-0 w-full overflow-hidden">
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
        className="block w-full"
        role="img"
        aria-label={`Cashflow: ${formatCents(total)} from ${left.length} sources to ${right.length} destinations`}
        /*
         * Full width, always; the height is whatever the layout came to.
         *
         * Nothing here scales. The viewBox is a fixed 1000 units wide and the
         * element is always the full width of its tile, so one user unit is a
         * constant number of pixels — and `barsFor` has already decided how much
         * chart fits the height available.
         *
         * Setting a height here as well would hand the drawing back to
         * `preserveAspectRatio`, which moves both dimensions together: that is
         * the whole reason dragging a row shorter used to make the chart
         * narrower, a postage stamp between two bands of white while the tile it
         * sits in stayed exactly as wide as before.
         */
        style={{ fontVariantNumeric: 'tabular-nums' }}
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
          height={bars}
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
            fontSize={labelSize}
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
            fontSize={labelSize}
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
          y={midTop - 4 * fit - totalSize / 2}
          textAnchor="middle"
          fontSize={totalSize}
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
