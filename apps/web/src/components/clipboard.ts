/**
 * Putting a short string on the clipboard, on an origin that is often not
 * secure.
 *
 * `navigator.clipboard` exists only in a *secure context*. This application
 * serves plain http at the origin by decision (ADR 017) — encrypted from away by
 * the tunnel or by Tor, plain on the LAN — so the LAN address, which is the one
 * used most, has no `navigator.clipboard` at all. A copy button written against
 * it alone would do nothing on the very device it was added for, and do it
 * silently.
 *
 * So there are three outcomes and the caller must handle all three. The one that
 * matters is the last: when nothing can write to the clipboard the text is
 * *selected* instead, and the interface says to press the copy key. A control
 * that appears to work and does not is worse than one that admits it cannot.
 */

export type CopyOutcome =
  /** On the clipboard. */
  | 'copied'
  /** Selected instead; the caller should tell the reader to copy it themselves. */
  | 'selected'
  /** Neither worked. Rare, and still not silent. */
  | 'failed';

/**
 * Copies by selecting a node's contents and asking the document to copy them.
 *
 * `document.execCommand` is deprecated and is the only thing that works outside
 * a secure context, which is most of this deployment. It is kept behind the
 * modern API rather than in front of it, so it disappears on its own the day
 * every path here is https.
 */
function copyBySelectingNode(node: Node): boolean {
  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);

  try {
    // Leaves the selection in place on purpose. If this returns false the text
    // is highlighted and ready for the reader's own copy key, which is the
    // fallback behind the fallback.
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

/**
 * Copies `value`, using whichever mechanism this browser and this origin allow.
 *
 * `node` is the element displaying the value, used for the selection fallback.
 * The value and the node's text may legitimately differ — a secret is displayed
 * in groups of four and copied without the spaces — and when they do, the
 * clipboard gets `value` and the selection shows the node.
 */
export async function copyText(value: string, node: Node | null): Promise<CopyOutcome> {
  // Optional-chained rather than assumed: on a plain-http origin the whole
  // `clipboard` object is absent, not merely unusable.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return 'copied';
    } catch {
      // A permissions policy can refuse even in a secure context. Fall through
      // rather than report a failure the fallback might not have.
    }
  }

  if (node && copyBySelectingNode(node)) return 'copied';
  if (node && window.getSelection()?.toString()) return 'selected';
  return 'failed';
}

/**
 * A base32 authenticator secret, spaced for a person to read and type.
 *
 * Groups of four, which is what every authenticator that shows a key by hand
 * uses. The spaces are for the eye only — `copyText` is always given the
 * unspaced value, because a password manager offered `"ABCD EFGH"` may store the
 * space and then produce codes that never match, and a wrong second factor is
 * discovered at the worst possible moment.
 */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}
