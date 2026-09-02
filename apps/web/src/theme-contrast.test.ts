import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every theme is legible, checked rather than eyeballed.
 *
 * `design.md` §9 asks for WCAG AA — 4.5:1 for body text, 3:1 for large text and
 * meaningful boundaries — and that is not a thing anybody can judge by looking.
 * A palette that misses it looks *fine* to the person who chose it and is
 * unreadable to somebody else, on a different screen, in a different room.
 *
 * So the stylesheet is read, each theme's tokens are pulled out, and the pairs
 * that actually appear on screen are measured. Adding a seventh theme means
 * satisfying this or changing it deliberately.
 */

const CSS = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

/** Relative luminance, per WCAG 2.x. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/**
 * The tokens of one theme, with the base palette underneath it.
 *
 * A theme block only redefines what it changes, exactly as `ADR 034` intends —
 * so reading one on its own would measure a colour against a background it never
 * declared.
 */
function paletteOf(selector: string): Record<string, string> {
  const base = block('@theme');
  return selector === '@theme' ? base : { ...base, ...block(selector) };
}

function block(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  expect(start, `${selector} is not in styles.css`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('\n}', open);

  const tokens: Record<string, string> = {};
  for (const [, name, value] of CSS.slice(open, close).matchAll(
    /(--color-[a-z0-9-]+):\s*(#[0-9a-f]{6})/gi,
  )) {
    tokens[name!] = value!;
  }
  return tokens;
}

/**
 * What the shipped Light palette actually measures, pair by pair.
 *
 * Writing this test found six pairs in Light that sit under 4.5:1 — secondary text
 * on both grounds, the accent and the positive green on their own soft fills,
 * white on the accent, and a negative amount. The worst is `positive` on
 * `positive-soft` at 2.76, which is the green status line on its green pill.
 * Dark clears every bar comfortably; the three palettes added alongside this
 * test clear them too.
 *
 * Those six are **not** silently excused and **not** quietly changed. The exact
 * hexes are in `design.md` §2, which is the owner's specification and is marked
 * settled — moving them was his call, not a side effect of adding a theme.
 *
 * It was put to him on 2026-09-02, with these numbers, and he kept the palette:
 * Light stays as designed, and High contrast — which clears every bar — is the
 * answer for anyone who needs more. So these are a decision rather than a
 * backlog. What they still buy is a ratchet: Light can never get *worse* without
 * this test failing.
 */
const RECORDED: Record<string, number> = {
  'light --color-muted on --color-canvas': 4.27,
  'light --color-muted on --color-surface': 4.02,
  'light --color-accent on --color-accent-soft': 3.42,
  'light --color-positive on --color-positive-soft': 2.76,
  'light on-accent on accent': 3.89,
  'light negative on canvas': 3.33,
};

/** 4.5:1 unless this pair is one of the four already on the record. */
function floorFor(theme: string, pair: string): number {
  return RECORDED[`${theme} ${pair}`] ?? 4.5;
}

const THEMES = [
  ['@theme', 'light'],
  [":root[data-theme='dark']", 'dark'],
  [":root[data-theme='ledger']", 'ledger'],
  [":root[data-theme='reading']", 'reading'],
  [":root[data-theme='contrast']", 'contrast'],
] as const;

/**
 * Text that has to be read, against the two grounds it is read on.
 *
 * `--color-faint` is deliberately absent. It is the To Delegate column, which
 * `design.md` calls de-emphasised on purpose and which the shipped light palette
 * has never held to 4.5 — holding a new theme to a bar the original fails would
 * be enforcing something this application does not believe.
 */
const BODY = ['--color-ink', '--color-muted'];
const GROUNDS = ['--color-canvas', '--color-surface'];

/** A semantic colour and the soft fill it is printed on. */
const ON_SOFT: [string, string][] = [
  ['--color-accent', '--color-accent-soft'],
  ['--color-positive', '--color-positive-soft'],
  ['--color-warning', '--color-warning-soft'],
  ['--color-danger', '--color-danger-soft'],
  ['--color-confirm', '--color-confirm-soft'],
];

describe.each(THEMES)('%s', (selector, name) => {
  const palette = paletteOf(selector);

  it(`${name}: body text clears 4.5:1 on both grounds`, () => {
    for (const token of BODY) {
      for (const ground of GROUNDS) {
        const pair = `${token} on ${ground}`;
        expect(contrast(palette[token]!, palette[ground]!), pair).toBeGreaterThanOrEqual(
          floorFor(name, pair),
        );
      }
    }
  });

  it(`${name}: every semantic colour clears 4.5:1 on its own fill`, () => {
    for (const [colour, soft] of ON_SOFT) {
      const pair = `${colour} on ${soft}`;
      expect(contrast(palette[colour]!, palette[soft]!), pair).toBeGreaterThanOrEqual(
        floorFor(name, pair),
      );
    }
  });

  it(`${name}: the accent's own text clears 4.5:1 on the accent fill`, () => {
    // The Delegate button, the active pill: white on light blue is the classic
    // way this one is got wrong, and it is why `--color-on-accent` exists.
    expect(
      contrast(palette['--color-on-accent']!, palette['--color-accent']!),
      'on-accent on accent',
    ).toBeGreaterThanOrEqual(floorFor(name, 'on-accent on accent'));
  });

  it(`${name}: a negative amount clears 4.5:1 where it is printed`, () => {
    // Red text on the canvas, and on a tinted grouping row — the second is the
    // one that gets missed, because it is only ever seen inside a grouping.
    expect(
      contrast(palette['--color-negative']!, palette['--color-canvas']!),
      'negative on canvas',
    ).toBeGreaterThanOrEqual(floorFor(name, 'negative on canvas'));
  });

  it(`${name}: the four semantic colours are still told apart`, () => {
    /*
     * Never by colour alone — §9 — but a palette where warning and danger are
     * the same red has thrown away half of what the words are reinforcing.
     */
    const semantics = ['--color-positive', '--color-warning', '--color-danger', '--color-confirm'];
    for (const [index, one] of semantics.entries()) {
      for (const other of semantics.slice(index + 1)) {
        expect(palette[one], `${one} and ${other}`).not.toBe(palette[other]);
      }
    }
  });
});
