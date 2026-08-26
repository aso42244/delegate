import type { ReactNode } from 'react';
import { useDensity, type Density } from '../../display.js';
import { useTheme, type ThemeChoice } from '../../theme.js';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Display.
 *
 * Per-device, not per-household: everything here describes the screen someone is
 * looking at, so it is stored in the browser rather than the database. One
 * person preferring tight rows on a large monitor should not change what the
 * other sees on a phone, and one person reading in a dark room should not put
 * the other's phone into dark mode.
 *
 * Both cards say so once, at the bottom, rather than each repeating it.
 */

const DENSITIES: readonly { value: Density; label: string; detail: string }[] = [
  { value: 'comfortable', label: 'Comfortable', detail: '40px rows' },
  { value: 'compact', label: 'Compact', detail: '32px rows' },
  { value: 'dense', label: 'Dense', detail: '28px rows' },
];

const THEMES: readonly { value: ThemeChoice; label: string; detail: string }[] = [
  { value: 'system', label: 'System', detail: 'Follows this device' },
  { value: 'light', label: 'Light', detail: '' },
  { value: 'dark', label: 'Dark', detail: '' },
];

/** One radio list, since both cards are exactly that. */
function Choice<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  readonly name: string;
  readonly legend: string;
  readonly value: T;
  readonly options: readonly { value: T; label: string; detail: string }[];
  readonly onChange: (next: T) => void;
}): ReactNode {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{legend}</legend>

      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-2">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="text-ink">{option.label}</span>
          {option.detail !== '' && <span className="text-quiet text-muted">{option.detail}</span>}
        </label>
      ))}
    </fieldset>
  );
}

export function DisplaySection(): ReactNode {
  const [density, setDensity] = useDensity();
  const [theme, setTheme] = useTheme();

  return (
    <>
      <SettingsCard title="Theme" description="Light, dark, or whatever this device asks for.">
        <Choice name="theme" legend="Theme" value={theme} options={THEMES} onChange={setTheme} />
      </SettingsCard>

      <SettingsCard title="Row height" description="Spacing only — the text stays the same size.">
        <Choice
          name="density"
          legend="Row height"
          value={density}
          options={DENSITIES}
          onChange={setDensity}
        />

        <p className="mt-4 text-quiet text-muted">Both are remembered on this device only.</p>
      </SettingsCard>
    </>
  );
}
