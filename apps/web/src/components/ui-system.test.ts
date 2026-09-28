import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The mechanical half of docs/ui-system.md, enforced by reading the source.
 *
 * The look was never the problem. The execution drifted, one hurried change at a
 * time, until seventeen screens carried four page headers, five widths for the
 * same kind of field, and `gap-` at every value from 1 to 6. Nothing caught it
 * because nothing was looking.
 *
 * This is the thing that looks. It is a lint rule rather than a test of
 * behaviour, and it lives here rather than in ESLint because the rule is about
 * this design system and would mean nothing anywhere else.
 */

const WEB_SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) found.push(path);
  }
  return found;
}

const FILES = sourceFiles(WEB_SRC).map((path) => ({
  path: path.slice(WEB_SRC.length),
  text: readFileSync(path, 'utf8'),
}));

/**
 * 4, 8, 12, 16, 24 and nothing else.
 *
 * **Twelve was added deliberately in v0.59**, with the Overview redesign. Four
 * values held while every screen was a table or a form; a dashboard of small
 * cards has a real gap between "inside a card" (8) and "between blocks" (16),
 * and forcing it to one or the other made tiles either cramped or airy with
 * nothing in between. It is one more value, not an open door: 20, 28 and 32 are
 * still refused, and 32 was in the original proposal and left out because 24
 * already separates sections.
 *
 * `gap-x-6` and `gap-y-2` are on the scale and pass by construction. The
 * fractional paddings inside the segmented control and the Toggle are part of a
 * control's own geometry rather than layout spacing, so they are not swept up:
 * the pattern only matches whole numbers.
 */
const OFF_SCALE = /\b(?:gap|gap-x|gap-y|space-y|space-x|mt|mb|pt|pb)-(?:5|7|8|9|10|11)\b/g;

/**
 * The app shell keeps its own metrics from design.md §4 — a 232px sidebar and a
 * 28–36px content gutter — which predate this scale and are the frame the scale
 * sits inside rather than a use of it.
 */
const SHELL = ['App.tsx'];

/**
 * The three screens outside the shell: sign-in, the forced password change, and
 * enrolment. Each is a centred card with no navigation and no actions, so a page
 * header built for a title-plus-actions row would be the wrong shape.
 */
const OUTSIDE_THE_SHELL = [
  'pages/SignIn.tsx',
  'pages/ChangePassword.tsx',
  'pages/SetUpTwoFactor.tsx',
];

describe('the spacing scale', () => {
  it('uses only 4, 8, 16 and 24', () => {
    const offenders = FILES.filter(({ path }) => !SHELL.includes(path)).flatMap(({ path, text }) =>
      [...text.matchAll(OFF_SCALE)].map((match) => `${path}: ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * One page header, so "how far below the title does the page start" cannot be
 * answered differently on four pages again.
 */
describe('the page header', () => {
  it('is the shared component everywhere, never a hand-rolled h1', () => {
    const offenders = FILES.filter(
      ({ path, text }) =>
        text.includes('text-page') &&
        !path.endsWith('layout.tsx') &&
        !OUTSIDE_THE_SHELL.includes(path),
    ).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

/**
 * One box.
 *
 * Overview's tile, Settings' card and the bordered `<section>` every page reached
 * for were the same object written three times — same radius, same border, same
 * padding, two heading sizes and a third padding value on the two suggestion
 * panels. `Tile` is the box now, and a page that wants one asks for it rather
 * than drawing it again slightly differently. See ADR 061.
 */
describe('the tile', () => {
  it('is drawn in one place', () => {
    const surface = 'rounded-lg border border-line bg-canvas p-4';
    const offenders = FILES.filter(
      ({ path, text }) => text.includes(surface) && !path.endsWith('components/Tile.tsx'),
    ).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

/**
 * One dialog, so ADR 038 holds everywhere.
 *
 * The two hand-rolled overlays on the Budget page were centred cards on a phone
 * rather than sheets, took no notice of `visualViewport`, and could not be
 * closed with Escape — so the dialog somebody opens to *type an amount* put its
 * amount field and its confirm button underneath the software keyboard. A frame
 * written by hand is a frame that does not get the next fix either.
 */
describe('dialogs', () => {
  it('are the shared Modal, never a hand-rolled overlay', () => {
    const offenders = FILES.filter(
      ({ path, text }) => /role="dialog"/.test(text) && !path.endsWith('components/ui.tsx'),
    ).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

/**
 * `PageHeader` owns the 24px between a title and the page under it.
 *
 * That is the whole reason the step lives in the component rather than in each
 * caller — and the Rules page then wrapped it in a `gap-6` column, so its one
 * tile started 48px below the title while every tile on Overview started 24px
 * below its own. Invisible on either page alone.
 */
describe('the step below a page title', () => {
  it('is the header component alone, never doubled by a wrapper', () => {
    const doubled = /flex-col[^"'`]*\bgap-\d[\s\S]{0,240}?<PageHeader/g;
    const offenders = FILES.flatMap(({ path, text }) =>
      [...text.matchAll(doubled)].map(() => path),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * Content inside a tile asks how wide the **tile** is.
 *
 * A `md:` breakpoint asks how wide the window is, which stopped being the same
 * question the moment a tile stopped being the whole row: a third-width tile on
 * a 1440px screen is 345px across and was handed the layout meant for 640. That
 * is how the backups table drew its columns past its own border in v0.49, and
 * how the bills table would size seven columns for a window it only has
 * two-thirds of. Column widths and table layout are where it bites, so those are
 * what this checks.
 */
describe('widths inside a tile', () => {
  it('are container queries, never window ones', () => {
    const windowWidth = /(?<![@\w-])(?:sm|md|lg|xl|2xl):(?:w-\d|table-fixed)/g;
    const offenders = FILES.filter(({ path }) => !SHELL.includes(path)).flatMap(({ path, text }) =>
      [...text.matchAll(windowWidth)].map((match) => `${path}: ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * A field states its own width. Left to `w-full` on a page it takes whatever the
 * container happens to be, which is how one text input came to be three
 * different widths on three tabs of one page.
 */
describe('field widths', () => {
  it('are declared at every call site', () => {
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (!/<(TextField|SelectField|TextArea)(\s|$)/.test(line)) return;
        // The opening tag and its props, up to the closing bracket.
        const block = lines.slice(index, index + 14).join('\n');
        const end = block.indexOf('/>');
        const opening = end === -1 ? block : block.slice(0, end);
        if (!opening.includes('width=')) offenders.push(`${path}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * One disclosure idiom. `<details>` draws its own marker, in its own font, at a
 * size nothing else on the page uses.
 */
describe('disclosures', () => {
  it('are the shared component, never a bare details element', () => {
    // Not preceded by a backtick: layout.tsx names it in a comment explaining
    // why it is not used, and that mention is the point rather than a breach.
    const offenders = FILES.filter(({ text }) => /(^|[^`])<details/m.test(text)).map(
      ({ path }) => path,
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * Creating a thing happens in one place.
 *
 * The audit found Add, Create, New and "Set up" all in use — and both "Add
 * grouping" and "New grouping" for the same action, on two different screens.
 * Naming them all `New <noun>` fixed the words; it did not fix that there were
 * seven of them, each wherever its own page had room.
 *
 * So the entry point is `NewMenu`, in every page header, and a page no longer
 * carries a create button at all. What a page keeps is anything that is not
 * creating a thing — Delegate, Arrange, Run rules — and every row-level action.
 */
describe('button labels', () => {
  it('name creation one way', () => {
    // A submit button inside a create flow is the bare verb: the dialog title
    // already carries the noun, and repeating it is the extra word this whole
    // pass is about.
    const banned = /<Button[^>]*>\s*(?:Create\s+\w|Set up\s+\w|Add\s+an?\s)/g;
    const offenders = FILES.flatMap(({ path, text }) =>
      [...text.matchAll(banned)].map((match) => `${path}: ${match[0].slice(-32).trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('put every create behind the one menu', () => {
    /*
     * `New <noun>` on a page is now a second route to something the header
     * already offers, and two routes to one action are how "Add grouping" and
     * "New grouping" came to exist in the first place.
     *
     * `NewMenu` itself is exempt: it is the menu, and its items are nouns
     * without the word.
     */
    const banned = /<Button[^>]*>\s*New\s+\w/g;
    const offenders = FILES.filter(({ path }) => !path.endsWith('NewMenu.tsx')).flatMap(
      ({ path, text }) =>
        [...text.matchAll(banned)].map((match) => `${path}: ${match[0].slice(-32).trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
