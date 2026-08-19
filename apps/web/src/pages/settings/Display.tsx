import type { ReactNode } from 'react';
import { useDensity, type Density } from '../../display.js';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Display.
 *
 * Per-device, not per-household: this describes the screen someone is looking
 * at, so it is stored in the browser rather than the database. One person
 * preferring tight rows on a large monitor should not change what the other
 * sees on a phone.
 */

const OPTIONS: readonly { value: Density; label: string; detail: string }[] = [
  { value: 'comfortable', label: 'Comfortable', detail: '40px rows' },
  { value: 'compact', label: 'Compact', detail: '32px rows' },
  { value: 'dense', label: 'Dense', detail: '28px rows' },
];

export function DisplaySection(): ReactNode {
  const [density, setDensity] = useDensity();

  return (
    <SettingsCard
      title="Row height"
      description="How much room each row in a table takes. Only the spacing changes — the text stays the same size."
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Row height</legend>

        {OPTIONS.map((option) => (
          <label key={option.value} className="flex items-center gap-2">
            <input
              type="radio"
              name="density"
              value={option.value}
              checked={density === option.value}
              onChange={() => setDensity(option.value)}
            />
            <span className="text-ink">{option.label}</span>
            <span className="text-quiet text-muted">{option.detail}</span>
          </label>
        ))}
      </fieldset>

      <p className="mt-3 text-quiet text-muted">This setting is remembered on this device only.</p>
    </SettingsCard>
  );
}
