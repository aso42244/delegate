# 048. A theme is a palette that is measured

**Status:** accepted
**Date:** 2026-09-02

## Context

[ADR 034](034-dark-mode-is-a-second-palette-not-an-inversion.md) established that
dark mode is a second palette designed on its own ground rather than an inversion
of the first. Three more were asked for, which turns "a second palette" into a
system: six choices, five of them explicit, all of them keyed on one attribute.

Two questions come with that. What is a theme allowed to change? And how does
anybody know a new one is readable?

The second is the one that matters. A palette that misses contrast looks
**fine** to the person who chose it — they picked it because they could read it,
on their screen, in their room. `design.md` §9 asks for WCAG AA, and until now
nothing measured it.

## Decision

**A theme is a token swap and nothing else.** The colour tokens, plus
`--font-sans` and `--tracking-label`. Layout, spacing, the chip vocabulary, row
heights and every measurement in `ui-system.md` are outside it. A theme that
needs a different layout is not a theme.

`--tracking-label` is new, and it exists for exactly one theme: monospace
capitals are already wide, and 0.05em turns an 11px column header into a row of
gaps. It is a token rather than a number in nineteen `<th>` elements.

**Every theme is measured, and the test is the gate.**
`theme-contrast.test.ts` reads `styles.css`, extracts each theme's tokens over
the base palette, and asserts the pairs that actually appear on screen:

- body text on both grounds, 4.5:1
- each semantic colour on its own soft fill, 4.5:1
- `--color-on-accent` on `--color-accent`, 4.5:1
- a negative amount on the canvas, 4.5:1
- the four semantic colours still distinct from each other

`--color-faint` is deliberately excluded. It is the To Delegate column, which
`design.md` calls de-emphasised on purpose, and holding a new theme to a bar the
shipped one has never met would be enforcing something this application does not
believe.

### What the test found

**Six pairs in the shipped Light palette sit under 4.5:1.** Secondary text on
both grounds (4.27 and 4.02), the accent on its own soft fill (3.42), the
positive green on its soft fill (**2.76**), white on the accent (3.89), and a
negative amount on white (3.33). Dark clears every bar. The three new palettes
clear every bar.

Those six are **recorded at their measured values** rather than excused or
quietly fixed. The exact hexes are in `design.md` §2, which is the owner's
specification and is marked settled — moving them is a decision for him, not a
side effect of adding a theme. Recording them means the ratio can never get
_worse_ without the test failing, and the numbers now live somewhere the decision
can be taken from.

### The three

**Ledger** is the monospace one, and it changes the face everywhere. A page half
in monospace reads as a mistake rather than a decision — and this application is
a ledger, so the whole grid lining up is the point rather than only the money
column. Everything else gets quieter to pay for it: warm paper, a burnt amber
accent instead of a blue that would compete, ink-adjacent grouping presets
because a saturated tint on paper reads as a highlighter. It costs width —
monospace runs about 15% wider, so long merchant names truncate sooner here.

**Reading light** is the only one solving a problem rather than choosing a look:
a parchment ground at reduced luminance with the blue taken out, for doing this
at ten at night in a lit room. Its semantics are re-chosen against that ground —
terracotta, moss — because a cool accent on a warm dim ground reads as a screen
with the brightness turned down rather than as paper under a lamp.

**High contrast** is a setting rather than a style. Pure black on pure white,
every other value pushed to the most saturated legible one, and `--color-line` at
5:1 so a hairline reads as a real boundary. It exists because quiet greys are a
preference and legibility is not.

## Consequences

**`system` is still the only choice that resolves to something else.** It means
"follow the device", and a device has two opinions. Every other choice is stamped
as itself — a theme somebody picked is not something a media query gets to
overrule.

**A seventh theme has to satisfy the test or change it deliberately**, which is
the whole point. The alternative is what happened here: a palette shipping with a
2.76:1 pair in it for a year, because nobody had a number.

**The recorded exceptions were put to the owner, and he kept them.** Asked on
2026-09-02 whether Light should be tightened to clear 4.5:1, the answer was to
leave it: he likes the palette as it is, and High contrast — which clears every
bar — is the answer for anybody who needs more. So `design.md` §2 stands
unchanged and the six entries stay. They are a decision now, not an oversight.

What the recording still buys is a ratchet: Light cannot get *worse* without the
test failing. If the six are ever tightened, the entries come out and the floor
returns to 4.5 on its own.
