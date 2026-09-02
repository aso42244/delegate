import type { ReactNode } from 'react';
import { useBudgetLayout, type BudgetLayout } from '../../budget-layout.js';
import { useDensity, type Density } from '../../display.js';
import { useTheme, type ThemeChoice } from '../../theme.js';
import { useSettingsTabs } from '../../settings-tabs.js';
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
 * They say so once, in the last card, rather than each repeating it — and inside
 * a card rather than as a paragraph under them, because a trailing explanation
 * under the content is the thing `ui-system.md` §3 bans.
 */

const DENSITIES: readonly { value: Density; label: string; detail: string }[] = [
  { value: 'comfortable', label: 'Comfortable', detail: '40px rows' },
  { value: 'compact', label: 'Compact', detail: '32px rows' },
  { value: 'dense', label: 'Dense', detail: '28px rows' },
];

const LAYOUTS: readonly { value: BudgetLayout; label: string; detail: string }[] = [
  { value: 'stacked', label: 'Stacked', detail: 'Assets, Debts, then Delegations' },
  { value: 'columns', label: 'Two columns', detail: 'Delegations beside the accounts' },
];

/**
 * The three device-following states first, then the three that are a decision.
 *
 * Each of the last three gets a line, because a name alone does not say what it
 * is for — and one of them is a setting rather than a taste.
 */
const THEMES: readonly { value: ThemeChoice; label: string; detail: string }[] = [
  { value: 'system', label: 'System', detail: 'Follows this device' },
  { value: 'light', label: 'Light', detail: '' },
  { value: 'dark', label: 'Dark', detail: '' },
  { value: 'ledger', label: 'Ledger', detail: 'Monospace, on paper' },
  { value: 'reading', label: 'Reading light', detail: 'Warm and dim, for late on' },
  { value: 'contrast', label: 'High contrast', detail: 'Every value at the far end' },
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

const SETTINGS_TABS = [
  { value: 'top' as const, label: 'Across the top', detail: 'A row above the cards' },
  { value: 'side' as const, label: 'Down the side', detail: 'A column beside them' },
];

export function DisplaySection(): ReactNode {
  const [density, setDensity] = useDensity();
  const [theme, setTheme] = useTheme();
  const [budgetLayout, setBudgetLayout] = useBudgetLayout();
  const [settingsTabs, setSettingsTabs] = useSettingsTabs();

  return (
    <>
      {/* Each of these is a few radio buttons, so each takes a third of the row
          rather than all of it — which is what they were doing, three deep down
          a page that had room for them side by side. */}
      <SettingsCard
        span="third"
        title="Theme"
        description="Six palettes, or whatever this device asks for."
      >
        <Choice name="theme" legend="Theme" value={theme} options={THEMES} onChange={setTheme} />
      </SettingsCard>

      <SettingsCard
        span="third"
        title="Budget layout"
        description="Where the three sections sit on the Budget page."
      >
        <Choice
          name="budgetLayout"
          legend="Budget layout"
          value={budgetLayout}
          options={LAYOUTS}
          onChange={setBudgetLayout}
        />

        {/*
          The one choice here whose effect depends on the screen rather than only
          on taste, so it is worth a line: below a wide window there is no room
          for two columns and the page falls back to one — keeping this
          arrangement's own order, envelopes first.
        */}
        <p className="mt-4 text-quiet text-muted">
          Two columns need a wide window. Narrower than that, both stack.
        </p>
      </SettingsCard>

      <SettingsCard
        span="third"
        title="Row height"
        description="Spacing only — the text stays the same size."
      >
        <Choice
          name="density"
          legend="Row height"
          value={density}
          options={DENSITIES}
          onChange={setDensity}
        />

        <p className="mt-4 text-quiet text-muted">Remembered on this device only.</p>
      </SettingsCard>

      <SettingsCard
        span="third"
        title="Settings tabs"
        description="Where these sections are listed."
      >
        <Choice
          name="settingsTabs"
          legend="Settings tabs"
          value={settingsTabs}
          options={SETTINGS_TABS}
          onChange={setSettingsTabs}
        />

        {/* Last card, so it closes the page — rather than a paragraph under the
            cards, which is the trailing explanation the system bans. */}
        <p className="mt-4 text-quiet text-muted">
          Every choice on this page is remembered on this device only.
        </p>
      </SettingsCard>
    </>
  );
}
