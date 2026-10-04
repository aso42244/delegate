import { api } from './client.js';

/** Brokerage positions and lots (ADR 080). Cents and shares are decimal strings. */

export interface LotDto {
  readonly id: string;
  /** `YYYY-MM-DD`. */
  readonly purchasedOn: string;
  readonly shares: string;
  readonly costCents: string;
  readonly note: string | null;
  readonly valueCents: string;
  readonly gainCents: string;
  readonly benchmarkValueCents: string | null;
  readonly versusBenchmarkCents: string | null;
}

export interface PositionDto {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly symbol: string;
  readonly description: string | null;
  readonly shares: string;
  readonly marketValueCents: string;
  readonly feedCostBasisCents: string | null;
  readonly asOf: string;
  readonly lotShares: string;
  readonly lotCostCents: string;
  readonly shareCoverage: 'none' | 'short' | 'matched' | 'over';
  readonly costDifferenceCents: string | null;
  readonly lots: readonly LotDto[];
}

export interface InvestmentsDto {
  readonly benchmark: {
    readonly symbol: string;
    readonly latestDate: string | null;
    readonly latestCloseCents: string | null;
  };
  readonly totals: {
    readonly marketValueCents: string;
    readonly lotCostCents: string;
    readonly lotValueCents: string;
    readonly benchmarkValueCents: string;
  };
  readonly positions: readonly PositionDto[];
}

export interface LotInput {
  readonly purchasedOn: string;
  readonly shares: string;
  readonly costCents: string;
  readonly note?: string | null;
}

export const investmentsApi = {
  get: () => api.get<InvestmentsDto>('/api/investments'),
  addLot: (positionId: string, input: LotInput) =>
    api.post<{ lot: { id: string } }>(`/api/investments/positions/${positionId}/lots`, input),
  updateLot: (lotId: string, input: LotInput) =>
    api.patch<{ ok: boolean }>(`/api/investments/lots/${lotId}`, input),
  archiveLot: (lotId: string) =>
    api.post<{ ok: boolean }>(`/api/investments/lots/${lotId}/archive`, {}),
  refreshBenchmark: () => api.post<{ stored: number }>('/api/investments/benchmark/refresh', {}),
};
