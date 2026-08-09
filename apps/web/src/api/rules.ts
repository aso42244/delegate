import { api } from './client.js';

/** Auto-categorization rules. Cents are decimal strings — ADR 002. */

export type RuleMatchMode = 'contains' | 'starts_with' | 'regex';
export type RuleDirection = 'any' | 'debit' | 'credit';

export interface RuleDto {
  readonly id: string;
  readonly name: string | null;
  readonly priority: number;
  readonly matchMode: RuleMatchMode;
  readonly matchValue: string;
  readonly amountMinCents: string | null;
  readonly amountMaxCents: string | null;
  readonly accountId: string | null;
  readonly direction: RuleDirection;
  readonly enabled: boolean;
  readonly delegation: {
    readonly id: string;
    readonly name: string;
    readonly archivedAt: string | null;
  };
}

export interface RuleInput {
  readonly name?: string | null;
  readonly matchMode?: RuleMatchMode;
  readonly matchValue?: string;
  readonly delegationId?: string;
  readonly amountMinCents?: string | null;
  readonly amountMaxCents?: string | null;
  readonly accountId?: string | null;
  readonly direction?: RuleDirection;
  readonly enabled?: boolean;
}

export interface RulePreviewDto {
  readonly examined: number;
  readonly categorized: number;
}

export interface ApplyRulesDto {
  readonly examined: number;
  readonly categorized: number;
}

export const rulesApi = {
  list: () => api.get<{ rules: readonly RuleDto[] }>('/api/rules'),

  create: (
    input: RuleInput & { matchMode: RuleMatchMode; matchValue: string; delegationId: string },
  ) => api.post<{ rule: { id: string } }>('/api/rules', input),

  update: (id: string, input: RuleInput) => api.patch<{ ok: boolean }>(`/api/rules/${id}`, input),

  archive: (id: string) => api.post<{ ok: boolean }>(`/api/rules/${id}/archive`),

  /** The whole order in one call, so rules cannot half-apply into an order nobody chose. */
  reorder: (ruleIds: readonly string[]) =>
    api.post<{ ok: boolean }>('/api/rules/reorder', { ruleIds }),

  /**
   * How many rows an apply would touch. The flag is sent as an explicit string:
   * the server parses "true" rather than coercing, because `Boolean("false")`
   * is true and this number decides whether a year of history gets rewritten.
   */
  preview: (includeCategorized: boolean) =>
    api.get<RulePreviewDto>(
      `/api/rules/preview?includeCategorized=${includeCategorized ? 'true' : 'false'}`,
    ),

  apply: (includeCategorized: boolean) =>
    api.post<ApplyRulesDto>('/api/rules/apply', { includeCategorized }),
};
