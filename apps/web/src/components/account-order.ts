/**
 * Putting hidden rows back into an order that was made without them.
 *
 * The band at the top of Overview can hide accounts sitting at zero — a closed
 * card is the commonest of them, and a dashboard is the wrong place to read a
 * list of nothings. `BudgetSection` builds its new ordering from the section it
 * was handed, so on a filtered list it produces an order over the *visible* rows
 * only, and that is not a thing either endpoint can be given:
 *
 * - `placeAccount` writes `position = (index + 1) * 10` for exactly the ids it
 *   is sent, and leaves every other row's position alone. A three-row order sent
 *   for a six-row list renumbers three of them into positions the other three
 *   already hold, and the result is ties broken arbitrarily. Nothing fails; the
 *   list is simply wrong afterwards, which is the worse of the two outcomes.
 * - `reorderGroupings` refuses a partial list outright. Safer, and still a
 *   failure somebody has to see.
 *
 * So the filter hides rows and never narrows what is written. This is the
 * function that widens it again. It is here rather than inside the component
 * because it is the part worth proving, and because the cases that exercise it
 * need an account at exactly zero sitting between two that are not — a fixture
 * about arithmetic rather than about dragging.
 */

/**
 * The full order, given the order of the part that was visible.
 *
 * `full` is every sibling as the server last described them, hidden ones
 * included. `visible` is the order the component produced over the rows it was
 * given, after the move.
 *
 * **Each hidden id stays attached to the visible id it followed.** That is the
 * whole rule, and it needs no idea of which row was dragged: a closed card filed
 * under Savings after "Everyday Checking" is still after Everyday Checking
 * wherever that moves to, rather than being swept to one end because nobody
 * could see it. A hidden id that followed nothing visible stays at the front.
 *
 * An id in `visible` that is not in `full` is a row arriving from another
 * grouping, and simply lands where it was dropped.
 */
export function restoreHidden(full: readonly string[], visible: readonly string[]): string[] {
  const shown = new Set(visible);

  /** Hidden ids by the visible id they follow; `null` for the front. */
  const trailing = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of full) {
    if (shown.has(id)) {
      anchor = id;
      continue;
    }
    const at = trailing.get(anchor);
    if (at) at.push(id);
    else trailing.set(anchor, [id]);
  }

  // Nothing was hidden: the component's own answer, untouched.
  if (trailing.size === 0) return [...visible];

  return [
    ...(trailing.get(null) ?? []),
    ...visible.flatMap((id) => [id, ...(trailing.get(id) ?? [])]),
  ];
}
