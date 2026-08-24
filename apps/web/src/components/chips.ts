/**
 * The chip vocabulary.
 *
 * Every mark that sits beside a row's name is one letter — two where one would
 * collide, and `btc`, which is a word everybody already reads as one. A chip is
 * a classification, not a sentence: at eleven pixels a word costs a row's width
 * and says no more than its initial does once the initial is known.
 *
 * Two rules make that safe, and both are enforced rather than promised.
 *
 * **One letter, one meaning, across the whole application** — not per page. A
 * `p` that means pending in the register and property on the budget is a
 * vocabulary nobody can learn. `chips.test.ts` fails if two entries share a
 * mark.
 *
 * **The word is always there.** Every chip renders its letter for the eye and
 * its full meaning for a screen reader, with the same text as a `title` for
 * anyone who hovers. A letter with no expansion is a private joke.
 */

export type ChipTone = 'quiet' | 'warning';

export interface ChipSpec {
  /** What is shown. One character, or two where one would collide. */
  readonly mark: string;
  /** What it means, read aloud and shown on hover. Not a repeat of the mark. */
  readonly meaning: string;
  readonly tone: ChipTone;
}

export const CHIPS = {
  // ── Transactions ──────────────────────────────────────────────────────────
  /** Yellow: a pending row has already moved its envelope while the account
      balance has not caught up, which is a thing to notice rather than a thing
      to know. */
  pending: { mark: 'p', meaning: 'Pending — the bank has not settled it yet', tone: 'warning' },
  income: { mark: 'i', meaning: 'Income — allocates to nothing', tone: 'quiet' },
  transfer: { mark: 't', meaning: 'Transfer between your own accounts', tone: 'quiet' },
  check: { mark: 'c', meaning: 'Settled an outstanding check', tone: 'quiet' },
  split: { mark: 'sp', meaning: 'Split across more than one delegation', tone: 'quiet' },

  // ── Accounts, on the budget and in Settings ───────────────────────────────
  manual: { mark: 'm', meaning: 'Kept by hand', tone: 'quiet' },
  stale: { mark: 's', meaning: 'Not confirmed recently', tone: 'warning' },
  review: { mark: 'r', meaning: 'Discovered by a sync — its type is a guess', tone: 'warning' },
  /** The only three-letter mark, because it is already read as a word. The
      figure on these rows is a quantity times a price and moves on its own once
      a day with no transaction behind it — ADR 021. Nothing else said so. */
  bitcoin: { mark: 'btc', meaning: 'Bitcoin holding — quantity × price', tone: 'quiet' },
  /** `h` for house rather than `p`, which is spent on pending. */
  property: { mark: 'h', meaning: 'Property — a valuation, not a balance', tone: 'quiet' },

  // ── Delegations ───────────────────────────────────────────────────────────
  utility: { mark: 'u', meaning: 'Utility — tracked on the Utilities page', tone: 'quiet' },
  note: { mark: 'n', meaning: 'Has a note', tone: 'quiet' },
} as const satisfies Record<string, ChipSpec>;

export type ChipKind = keyof typeof CHIPS;
