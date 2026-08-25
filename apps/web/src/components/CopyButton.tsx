import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from './ui.jsx';
import { copyText, type CopyOutcome } from './clipboard.js';

/**
 * A button that puts a value on the clipboard and says what actually happened.
 *
 * The saying-what-happened is the point. On a plain-http origin — which the LAN
 * address is, by decision — `navigator.clipboard` does not exist, so the naive
 * version of this button is a control that looks like it worked and did not.
 * The three outcomes are reported differently and none of them is silence.
 *
 * `displayRef` points at the element showing the value, for the selection
 * fallback. The displayed text and the copied value may differ — a secret is
 * shown in groups of four and copied without the spaces.
 */

/** Long enough to be read, short enough that the button is ready again. */
const CONFIRMATION_MS = 4000;

function copyKeyName(): string {
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘C' : 'Ctrl+C';
}

function messageFor(outcome: CopyOutcome): string {
  switch (outcome) {
    case 'copied':
      return 'Copied.';
    case 'selected':
      // The text is highlighted and the browser refused to copy it for us. This
      // is one keystroke from done, so it says which keystroke.
      return `Selected — press ${copyKeyName()} to copy it.`;
    case 'failed':
      return 'Could not copy it. Select the key and copy it by hand.';
  }
}

export function CopyButton({
  value,
  displayRef,
  label = 'Copy',
  describes,
}: {
  readonly value: string;
  readonly displayRef: RefObject<HTMLElement | null>;
  readonly label?: string;
  /** Names what is being copied, for a screen reader: "Copy the setup key". */
  readonly describes?: string;
}): ReactNode {
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  async function run(): Promise<void> {
    const result = await copyText(value, displayRef.current);
    setOutcome(result);

    if (timer.current !== null) clearTimeout(timer.current);
    // A failure stays up: it asks the reader to do something, and clearing it
    // mid-read would leave them with no instruction and no error.
    if (result === 'copied') {
      timer.current = setTimeout(() => setOutcome(null), CONFIRMATION_MS);
    }
  }

  // The label does not change to "Copied". The live region beside it already
  // says so, and a button that relabels itself says the same thing twice on
  // screen while giving a screen reader two events for one action.
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        onClick={() => {
          void run();
        }}
        {...(describes === undefined ? {} : { 'aria-label': describes })}
      >
        {label}
      </Button>

      {/* Polite rather than assertive: this confirms something the reader just
          asked for, and interrupting them to say "yes, done" is worse than
          waiting for a pause. */}
      <span
        role="status"
        aria-live="polite"
        className={`text-quiet ${outcome === 'failed' ? 'text-danger' : 'text-muted'}`}
      >
        {outcome === null ? '' : messageFor(outcome)}
      </span>
    </div>
  );
}
