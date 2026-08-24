import { formatCents, tryParseMoney } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { accountsApi } from '../../api/accounts.js';
import { budgetApi } from '../../api/budget.js';
import { ApiError } from '../../api/client.js';
import { rulesApi, type RuleDto, type RuleMatchMode } from '../../api/rules.js';
import { Alert, Button, Modal, SelectField, TextField, Toggle } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Rules.
 *
 * Rules are evaluated in priority order and the **first match wins** — no
 * scoring, no combining. The owner has to be able to look at a wrongly
 * categorized transaction and know exactly which rule did it, which any "best
 * match" scheme makes impossible. So the list is ordered, the order is editable,
 * and the order is what the page is really about.
 */

const MATCH_LABELS: Record<RuleMatchMode, string> = {
  contains: 'contains',
  starts_with: 'starts with',
  regex: 'matches the pattern',
};

const DIRECTION_LABELS = {
  any: 'Any direction',
  debit: 'Money out only',
  credit: 'Money in only',
} as const;

function describeAmountRange(rule: RuleDto): string | null {
  const min = rule.amountMinCents === null ? null : BigInt(rule.amountMinCents);
  const max = rule.amountMaxCents === null ? null : BigInt(rule.amountMaxCents);
  if (min === null && max === null) return null;
  // The range compares magnitude, because the owner thinks "between $20 and $50"
  // while spending is stored negative.
  if (min !== null && max !== null) return `${formatCents(min)}–${formatCents(max)}`;
  return min === null ? `up to ${formatCents(max!)}` : `${formatCents(min)} or more`;
}

function RuleRow({
  rule,
  index,
  total,
  onMove,
}: {
  readonly rule: RuleDto;
  readonly index: number;
  readonly total: number;
  readonly onMove: (from: number, to: number) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['rules'] });
  };
  const onError = (error: unknown): void =>
    setProblem(error instanceof ApiError ? error.message : 'Could not update this rule.');

  const update = useMutation({
    mutationFn: (input: Parameters<typeof rulesApi.update>[1]) => rulesApi.update(rule.id, input),
    onSuccess: refresh,
    onError,
  });

  const archive = useMutation({
    mutationFn: () => rulesApi.archive(rule.id),
    onSuccess: refresh,
    onError,
  });

  const range = describeAmountRange(rule);
  const label = rule.name ?? rule.matchValue;
  const qualifiers = [range, rule.direction !== 'any' ? DIRECTION_LABELS[rule.direction] : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <tr className="group border-b border-line last:border-0 hover:bg-surface">
        {/* The number is the behaviour: first match wins, so where a rule sits
            in this column is the whole of what it does relative to the others. */}
        <td className="row-cell w-10 pl-1 text-quiet text-muted">{index + 1}</td>

        <td className="row-cell overflow-hidden">
          <span className="block truncate text-ink">
            {rule.name ?? `Description ${MATCH_LABELS[rule.matchMode]} “${rule.matchValue}”`}
          </span>
        </td>

        <td className="row-cell w-44 overflow-hidden pr-2">
          <span className="block truncate text-quiet text-muted">
            {rule.delegation.name}
            {rule.delegation.archivedAt && ' (archived)'}
          </span>
        </td>

        <td className="row-cell w-44 overflow-hidden pr-2">
          <span className="block truncate text-quiet text-faint" title={qualifiers}>
            {qualifiers || '—'}
          </span>
        </td>

        <td className="row-cell w-20">
          <Toggle
            checked={rule.enabled}
            onChange={(next) => update.mutate({ enabled: next })}
            label={`${label} enabled`}
          />
        </td>

        {/* Revealed on hover like every other row control, so a list of forty
            rules is not a hundred and twenty pieces of chrome. */}
        <td className="row-cell w-28 pr-1">
          <div className="row-menu-trigger flex items-center justify-end gap-0.5">
            <button
              type="button"
              onClick={() => onMove(index, index - 1)}
              disabled={index === 0}
              aria-label={`Move ${label} up`}
              className="rounded px-1.5 py-0.5 text-quiet text-muted hover:bg-surface-2 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => onMove(index, index + 1)}
              disabled={index === total - 1}
              aria-label={`Move ${label} down`}
              className="rounded px-1.5 py-0.5 text-quiet text-muted hover:bg-surface-2 disabled:opacity-30"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => archive.mutate()}
              disabled={archive.isPending}
              aria-label={`Archive ${label}`}
              className="rounded px-1.5 py-0.5 text-label font-semibold text-danger hover:bg-danger-soft"
            >
              Archive
            </button>
          </div>
        </td>
      </tr>

      {problem && (
        <tr>
          <td colSpan={6} className="pb-2">
            <Alert>{problem}</Alert>
          </td>
        </tr>
      )}
    </>
  );
}

function AddRuleDialog({
  delegations,
  accounts,
  onDone,
}: {
  readonly delegations: readonly { id: string; name: string }[];
  readonly accounts: readonly { id: string; name: string }[];
  readonly onDone: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [matchMode, setMatchMode] = useState<RuleMatchMode>('contains');
  const [matchValue, setMatchValue] = useState('');
  const [delegationId, setDelegationId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [direction, setDirection] = useState<'any' | 'debit' | 'credit'>('any');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const parseBound = (text: string, label: string): string | null => {
        if (text.trim() === '') return null;
        const parsed = tryParseMoney(text);
        if (!parsed.ok) throw new ApiError(400, 'invalid_amount', `Enter a ${label} like 20.00.`);
        // Magnitudes: the range compares the size of the amount, not its sign.
        return (parsed.value < 0n ? -parsed.value : parsed.value).toString();
      };

      return rulesApi.create({
        matchMode,
        matchValue: matchValue.trim(),
        delegationId,
        direction,
        accountId: accountId === '' ? null : accountId,
        amountMinCents: parseBound(min, 'minimum'),
        amountMaxCents: parseBound(max, 'maximum'),
      });
    },
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['rules'] });
      onDone();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not create the rule.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Modal
      label="Create an auto-categorization rule"
      title="Add rule"
      description="Checked in order with the others; the first rule that matches a transaction wins."
      onClose={onDone}
      width="lg"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="flex gap-3">
          <div className="w-48">
            <SelectField
              label="When the description"
              value={matchMode}
              onChange={(value) => setMatchMode(value as RuleMatchMode)}
            >
              {Object.entries(MATCH_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="flex-1">
            <TextField
              label="This text"
              value={matchValue}
              onChange={(event) => setMatchValue(event.target.value)}
              placeholder="whole foods"
              autoComplete="off"
              {...(matchMode === 'regex'
                ? {
                    hint: 'A regular expression. It is checked when you save and rejected if it could run away.',
                  }
                : {})}
            />
          </div>
        </div>

        <SelectField label="Categorize as" value={delegationId} onChange={setDelegationId}>
          <option value="">Choose a delegation</option>
          {delegations.map((delegation) => (
            <option key={delegation.id} value={delegation.id}>
              {delegation.name}
            </option>
          ))}
        </SelectField>

        <div className="flex gap-3">
          <div className="flex-1">
            <TextField
              label="Smallest amount (optional)"
              value={min}
              onChange={(event) => setMin(event.target.value)}
              inputMode="decimal"
              className="money"
            />
          </div>
          <div className="flex-1">
            <TextField
              label="Largest amount (optional)"
              value={max}
              onChange={(event) => setMax(event.target.value)}
              inputMode="decimal"
              className="money"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <SelectField label="Account" value={accountId} onChange={setAccountId}>
              <option value="">Any account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="flex-1">
            <SelectField
              label="Direction"
              value={direction}
              onChange={(value) => setDirection(value as 'any' | 'debit' | 'credit')}
            >
              {Object.entries(DIRECTION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </SelectField>
          </div>
        </div>

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={matchValue.trim() === '' || delegationId === '' || create.isPending}
          >
            {create.isPending ? 'Adding…' : 'Add rule'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Running every rule over transactions already imported.
 *
 * A button and a confirmation rather than a card of its own. It was a panel
 * permanently open at the foot of the page — a preview query running on every
 * visit, and a toggle that changes what the button does sitting some distance
 * from the button. That is a lot of page for something pressed a handful of
 * times a year, and it is the one action here that can rewrite hundreds of rows.
 *
 * The preview is not decoration: "1 of 423" and "397 of 423" are completely
 * different decisions, and this runs across a whole backfilled year. Nothing
 * moves until the number has been shown, which is why it is fetched when the
 * dialog opens rather than being something to remember to look at.
 */
function RunRulesDialog({ onDone }: { readonly onDone: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const [includeCategorized, setIncludeCategorized] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['rules', 'preview', includeCategorized],
    queryFn: () => rulesApi.preview(includeCategorized),
  });

  const apply = useMutation({
    mutationFn: () => rulesApi.apply(includeCategorized),
    onSuccess: async (applied) => {
      setProblem(null);
      setResult(`${applied.categorized} of ${applied.examined} categorized.`);
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: (error: unknown) => {
      setResult(null);
      setProblem(error instanceof ApiError ? error.message : 'Could not apply the rules.');
    },
  });

  return (
    <Modal
      label="Run every enabled rule over existing transactions"
      title="Run rules"
      description="Runs every enabled rule over transactions already imported."
      onClose={onDone}
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-start gap-2 text-quiet text-ink">
          <Toggle
            checked={includeCategorized}
            onChange={setIncludeCategorized}
            label="Also change transactions already categorized"
          />
          Also change transactions already categorized
        </label>

        {includeCategorized && (
          <Alert tone="warning">
            This will replace categorizations you made by hand. Bulk actions run over hundreds of
            rows, and reversing a decision at that scale is very hard to notice afterwards.
          </Alert>
        )}

        <p className="text-quiet text-muted" role="status">
          {preview.isLoading
            ? 'Working out what would change…'
            : preview.data
              ? `${preview.data.categorized} of ${preview.data.examined} transactions would be categorized.`
              : ''}
        </p>

        {problem && <Alert>{problem}</Alert>}
        {result && <Alert tone="positive">{result}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onDone}>
            {result ? 'Done' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            onClick={() => apply.mutate()}
            disabled={apply.isPending || preview.data?.categorized === 0}
          >
            {apply.isPending ? 'Running…' : 'Run rules'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function RulesSection(): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);

  const rules = useQuery({ queryKey: ['rules'], queryFn: rulesApi.list });
  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  const delegations = view.data
    ? [
        ...view.data.delegations.groupings.flatMap((grouping) => grouping.rows),
        ...view.data.delegations.ungrouped,
      ].map((row) => ({ id: row.id, name: row.name }))
    : [];

  const reorder = useMutation({
    mutationFn: (ruleIds: readonly string[]) => rulesApi.reorder(ruleIds),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not reorder the rules.'),
  });

  function move(from: number, to: number): void {
    const ids = (rules.data?.rules ?? []).map((rule) => rule.id);
    if (to < 0 || to >= ids.length) return;

    const next = [...ids];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    reorder.mutate(next);
  }

  const list = rules.data?.rules ?? [];

  return (
    <SettingsCard
      title="Auto-categorization rules"
      description="Checked in this order, and the first one that matches wins. Nothing is scored or combined."
      action={
        <div className="flex gap-2">
          <Button onClick={() => setRunning(true)} disabled={list.length === 0}>
            Run rules
          </Button>
          <Button onClick={() => setAdding(true)}>Add rule</Button>
        </div>
      }
    >
      {rules.isLoading ? (
        <p className="text-quiet text-muted">Loading rules…</p>
      ) : list.length === 0 ? (
        <p className="text-quiet text-muted">
          No rules yet. The fastest way to build them is “always categorize like this” from a
          transaction.
        </p>
      ) : (
        <table className="w-full table-fixed border-t-2 border-ink">
          <thead>
            <tr className="text-label uppercase tracking-[0.05em] text-muted">
              <th className="row-cell w-10 pl-1 text-left font-normal">#</th>
              <th className="row-cell text-left font-normal">Rule</th>
              <th className="row-cell w-44 pr-2 text-left font-normal">Categorizes as</th>
              <th className="row-cell w-44 pr-2 text-left font-normal text-faint">Only when</th>
              <th className="row-cell w-20 text-left font-normal">On</th>
              <th className="row-cell w-28 pr-1" />
            </tr>
          </thead>
          <tbody>
            {list.map((rule, index) => (
              <RuleRow key={rule.id} rule={rule} index={index} total={list.length} onMove={move} />
            ))}
          </tbody>
        </table>
      )}

      {problem && (
        <div className="mt-2">
          <Alert>{problem}</Alert>
        </div>
      )}

      {adding && (
        <AddRuleDialog
          delegations={delegations}
          accounts={accounts.data?.accounts ?? []}
          onDone={() => setAdding(false)}
        />
      )}
      {running && <RunRulesDialog onDone={() => setRunning(false)} />}
    </SettingsCard>
  );
}
