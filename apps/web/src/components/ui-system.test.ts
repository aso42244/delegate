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
 * 4, 8, 16, 24 and nothing else.
 *
 * `gap-x-6` and `gap-y-2` are on the scale and pass by construction. The
 * fractional paddings inside the segmented control and the Toggle are part of a
 * control's own geometry rather than layout spacing, so they are not swept up:
 * the pattern only matches whole numbers.
 */
const OFF_SCALE = /\b(?:gap|gap-x|gap-y|space-y|space-x|mt|mb|pt|pb)-(?:3|5|7|8|9|10|11|12)\b/g;

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
 * Creating a thing is always `New <noun>`.
 *
 * The audit found Add, Create, New and "Set up" all in use — and both "Add
 * grouping" and "New grouping" for the same action, on two different screens.
 */
describe('button labels', () => {
  it('name creation one way', () => {
    // An entry point that opens a create flow is `New <noun>`. A submit button
    // inside that flow is the bare verb — the dialog title already carries the
    // noun, and repeating it is the extra word this whole pass is about.
    const banned = /<Button[^>]*>\s*(?:Create\s+\w|Set up\s+\w|Add\s+an?\s)/g;
    const offenders = FILES.flatMap(({ path, text }) =>
      [...text.matchAll(banned)].map((match) => `${path}: ${match[0].slice(-32).trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
