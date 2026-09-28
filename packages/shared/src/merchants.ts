/**
 * Merchant text: what makes two charges the same shop, and what a rule built
 * from one of them should match on.
 *
 * Shared rather than duplicated because the two sides have to agree. The server
 * groups the categorization history by `merchantKey` to suggest a delegation,
 * and the dialog that turns an accepted suggestion into a rule fills its field
 * with `suggestedMatchValue` from the same description. If those two drifted
 * apart, the rule created from a suggestion would stop matching the very
 * transactions that produced it — and nothing would say so.
 */

/**
 * A token shorter than this is noise, not a name.
 *
 * Feed descriptions carry reference fragments — `AMAZON MKTPL*RT4G93` leaves
 * `rt` and `g` behind once the digits go — and those differ on every charge from
 * the same merchant. Dropping them is what lets two Amazon charges land on one
 * key instead of two.
 */
const MIN_TOKEN_LENGTH = 3;

/**
 * How much of the description names the merchant.
 *
 * Three rather than one, so `Kroger Fuel` and `Kroger` are not forced together,
 * and rather than all of them, so a store number or a city does not split one
 * merchant across a dozen keys. It is a heuristic and it is allowed to be: every
 * suggestion carries the count it was drawn from, so a key that grouped the
 * wrong things says so on the row rather than hiding inside a confident answer.
 */
const KEY_TOKENS = 3;

/** Maximal runs of letters, lowercased, with the noise dropped. */
export function merchantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

/**
 * The key two charges from one merchant share.
 *
 * A description with no usable letters at all — some feeds send a bare reference
 * number — falls back to its own normalized text, so it groups with itself and
 * with nothing else. That is the correct answer for a row nothing can be said
 * about, and it is not the same as no key: a null would silently opt those rows
 * out of a count they belong in.
 */
export function merchantKey(text: string): string {
  const tokens = merchantTokens(text);
  if (tokens.length === 0) return text.toLowerCase().replace(/\s+/g, ' ').trim();
  return tokens.slice(0, KEY_TOKENS).join(' ');
}

/**
 * The text a rule built from this description should match on.
 *
 * It cannot be the key: the key is normalized and the rule matches the real
 * description, so `kroger cincinnati` — built by deleting `#123` from between
 * them — appears nowhere in `KROGER #123 CINCINNATI` and would match nothing.
 * So the longest leading run of the key that **is** actually present wins, and a
 * single token always is, because every token came from this text.
 *
 * Nor can it be the whole description, which is what makes the existing
 * `createRuleFromTransaction` useless in practice: `AMAZON MKTPL*RT4G93`
 * contains a reference that never occurs again, so a rule matching all of it
 * matches exactly the one transaction it was built from and nothing else, for
 * ever, silently.
 *
 * It is still a guess. It is offered in a field the reader can edit before the
 * rule is created, because a needle that is too broad is the one failure here
 * that is expensive.
 */
export function suggestedMatchValue(text: string): string {
  const tokens = merchantTokens(text);
  const haystack = text.toLowerCase();

  for (let count = Math.min(KEY_TOKENS, tokens.length); count >= 1; count -= 1) {
    const candidate = tokens.slice(0, count).join(' ');
    const at = haystack.indexOf(candidate);
    // The original casing, not the normalized copy: what is offered for editing
    // should look like the description it came from.
    if (at !== -1) return text.slice(at, at + candidate.length);
  }

  return text.trim();
}
