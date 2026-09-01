import type { InsightDisplay } from '@budget/shared';
import type { ReactNode } from 'react';

/**
 * A tile's shape, drawn small enough to scan a grid of them.
 *
 * The picker used to be a row of buttons carrying nothing but a title, so
 * choosing between "Net worth over time" and "Assets against debts" meant
 * reading every label and knowing already what each one drew. A reader looking
 * for a chart is looking for a *shape* first.
 *
 * Schematic rather than a real chart of real data. A thumbnail that fetched a
 * series would make the picker wait on twenty-one queries to answer a question
 * about form, and a household three days into its snapshots would see twenty-one
 * flat lines — every option looking identical at exactly the moment the picker
 * is most used. The shape is the honest thing to show, and it is the same shape
 * on the first day as on the thousandth.
 *
 * Two colours only, both tokens, so these follow the theme like everything else.
 */

/** A fixed viewBox: the geometry below is written in these coordinates. */
const W = 64;
const H = 36;

function Frame({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-9 w-16 shrink-0"
      aria-hidden
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
    >
      {children}
    </svg>
  );
}

/** One rising, wobbling series — the same points for the line and the area. */
const POINTS = '2,29 12,22 22,25 32,14 42,17 52,7 62,10';

export function TilePreview({ display }: { readonly display: InsightDisplay }): ReactNode {
  switch (display) {
    case 'line':
      return (
        <Frame>
          <polyline
            points={POINTS}
            className="fill-none stroke-accent"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Frame>
      );

    case 'area':
      return (
        <Frame>
          <polygon points={`${POINTS} 62,34 2,34`} className="fill-accent opacity-25" />
          <polyline
            points={POINTS}
            className="fill-none stroke-accent"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Frame>
      );

    case 'bars':
      return (
        <Frame>
          {[14, 24, 10, 30, 19, 34].map((height, index) => (
            <rect
              key={height}
              x={3 + index * 10}
              y={H - height}
              width={7}
              height={height}
              rx={1.5}
              className="fill-accent"
            />
          ))}
        </Frame>
      );

    case 'donut':
      // A ring drawn as a stroked circle, with one arc in the accent. The dash
      // array is the circumference split into the segment and the remainder.
      return (
        <Frame>
          <circle cx={W / 2} cy={H / 2} r={13} className="fill-none stroke-line" strokeWidth={7} />
          <circle
            cx={W / 2}
            cy={H / 2}
            r={13}
            className="fill-none stroke-accent"
            strokeWidth={7}
            strokeDasharray="31 51"
            transform={`rotate(-90 ${W / 2} ${H / 2})`}
          />
        </Frame>
      );

    case 'list':
      // A label and a right-aligned figure, three times — which is what every
      // list tile in this application actually looks like.
      return (
        <Frame>
          {[4, 15, 26].map((y, index) => (
            <g key={y}>
              <rect
                x={2}
                y={y}
                width={[26, 20, 30][index]}
                height={6}
                rx={2}
                className="fill-line"
              />
              <rect
                x={62 - [14, 18, 11][index]!}
                y={y}
                width={[14, 18, 11][index]}
                height={6}
                rx={2}
                className="fill-accent"
              />
            </g>
          ))}
        </Frame>
      );

    case 'number':
      // One big figure. A rule under it, because that is how the tile reads.
      return (
        <Frame>
          <rect x={16} y={7} width={32} height={15} rx={3} className="fill-accent" />
          <rect x={10} y={27} width={44} height={4} rx={2} className="fill-line" />
        </Frame>
      );

    default:
      return <Frame>{null}</Frame>;
  }
}
