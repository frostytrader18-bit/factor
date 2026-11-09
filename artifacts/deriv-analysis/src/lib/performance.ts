import type { ContractType } from './analysis-engine';
import type { AnalysisEngineId } from './contract-engines.ts';

export type PredictionOutcomeStart = {
  id: string;
  engineId: AnalysisEngineId;
  contractType: ContractType;
  signalKey: string;
  signalLabel: string;
  digit: number | null;
  marketSymbol: string;
  marketLabel: string;
  startedAt: number;
  expiresAt: number;
  baselineRate: number;
  backtestHits: number;
  backtestPredictions: number;
  backtestAccuracy: number;
  estimatedProbability: number;
  wilsonLowerBound: number;
  wilsonUpperBound: number;
  expectedValue: number | null;
};

export type PredictionOutcomeRecord = PredictionOutcomeStart & {
  wins: number;
  losses: number;
  observedTicks: number;
  squaredProbabilityError: number;
  status: 'tracking' | 'complete' | 'replaced' | 'interrupted';
};

export type MarketContractPerformance = {
  engineId: AnalysisEngineId;
  marketSymbol: string;
  marketLabel: string;
  contractType: ContractType;
  signalCount: number;
  observedTicks: number;
  wins: number;
  losses: number;
  accuracy: number | null;
  brierScore: number | null;
  expectedValue: number | null;
};

export function calculateExpectedValue(
  winProbability: number,
  stake: number | null,
  profitOnWin: number | null,
): number | null {
  if (!Number.isFinite(winProbability) || winProbability < 0 || winProbability > 1
    || stake === null || profitOnWin === null
    || !Number.isFinite(stake) || !Number.isFinite(profitOnWin)
    || stake <= 0 || profitOnWin < 0) {
    return null;
  }
  return winProbability * profitOnWin - (1 - winProbability) * stake;
}

export function isPredictionOutcomeRecord(value: unknown): value is PredictionOutcomeRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const validContracts: ContractType[] = ['match-digit', 'differ', 'over', 'under', 'even-odd'];
  const validStatuses: PredictionOutcomeRecord['status'][] = [
    'tracking',
    'complete',
    'replaced',
    'interrupted',
  ];

  const expectedEngineId = record.contractType === 'match-digit' || record.contractType === 'differ'
    ? 'matches-differs'
    : record.contractType === 'over' || record.contractType === 'under'
      ? 'over-under'
      : record.contractType === 'even-odd'
        ? 'even-odd'
        : null;

  return typeof record.id === 'string'
    && record.engineId === expectedEngineId
    && validContracts.includes(record.contractType as ContractType)
    && typeof record.signalKey === 'string'
    && typeof record.signalLabel === 'string'
    && (record.digit === null || (Number.isInteger(record.digit) && Number(record.digit) >= 0 && Number(record.digit) <= 9))
    && typeof record.marketSymbol === 'string'
    && typeof record.marketLabel === 'string'
    && typeof record.startedAt === 'number'
    && Number.isFinite(record.startedAt)
    && typeof record.expiresAt === 'number'
    && Number.isFinite(record.expiresAt)
    && typeof record.baselineRate === 'number'
    && Number.isFinite(record.baselineRate)
    && record.baselineRate >= 0
    && record.baselineRate <= 1
    && typeof record.backtestHits === 'number'
    && Number.isInteger(record.backtestHits)
    && record.backtestHits >= 0
    && typeof record.backtestPredictions === 'number'
    && Number.isInteger(record.backtestPredictions)
    && record.backtestPredictions >= record.backtestHits
    && typeof record.backtestAccuracy === 'number'
    && Number.isFinite(record.backtestAccuracy)
    && record.backtestAccuracy >= 0
    && record.backtestAccuracy <= 1
    && typeof record.estimatedProbability === 'number'
    && Number.isFinite(record.estimatedProbability)
    && record.estimatedProbability >= 0
    && record.estimatedProbability <= 1
    && typeof record.wilsonLowerBound === 'number'
    && Number.isFinite(record.wilsonLowerBound)
    && record.wilsonLowerBound >= 0
    && record.wilsonLowerBound <= 1
    && typeof record.wilsonUpperBound === 'number'
    && Number.isFinite(record.wilsonUpperBound)
    && record.wilsonUpperBound >= record.wilsonLowerBound
    && record.wilsonUpperBound <= 1
    && (record.expectedValue === null
      || (typeof record.expectedValue === 'number' && Number.isFinite(record.expectedValue)))
    && typeof record.wins === 'number'
    && Number.isInteger(record.wins)
    && record.wins >= 0
    && typeof record.losses === 'number'
    && Number.isInteger(record.losses)
    && record.losses >= 0
    && typeof record.observedTicks === 'number'
    && Number.isInteger(record.observedTicks)
    && record.observedTicks === record.wins + record.losses
    && typeof record.squaredProbabilityError === 'number'
    && Number.isFinite(record.squaredProbabilityError)
    && record.squaredProbabilityError >= 0
    && validStatuses.includes(record.status as PredictionOutcomeRecord['status']);
}

function migratePerformanceRecord(value: unknown): PredictionOutcomeRecord | null {
  if (isPredictionOutcomeRecord(value)) return value;
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const engineId = record.contractType === 'match-digit' || record.contractType === 'differ'
    ? 'matches-differs'
    : record.contractType === 'over' || record.contractType === 'under'
      ? 'over-under'
      : record.contractType === 'even-odd'
        ? 'even-odd'
        : null;
  const probability = typeof record.estimatedProbability === 'number'
    ? record.estimatedProbability
    : typeof record.backtestAccuracy === 'number'
      ? record.backtestAccuracy
      : null;
  const lowerBound = typeof record.wilsonLowerBound === 'number'
    ? record.wilsonLowerBound
    : 0;
  const upperBound = typeof record.wilsonUpperBound === 'number'
    ? record.wilsonUpperBound
    : Math.max(lowerBound, probability ?? lowerBound);
  const wins = typeof record.wins === 'number' ? record.wins : -1;
  const losses = typeof record.losses === 'number' ? record.losses : -1;
  const observedTicks = typeof record.observedTicks === 'number'
    ? record.observedTicks
    : wins + losses;
  const squaredProbabilityError = typeof record.squaredProbabilityError === 'number'
    ? record.squaredProbabilityError
    : probability !== null && wins >= 0 && losses >= 0
      ? wins * ((1 - probability) ** 2) + losses * (probability ** 2)
      : Number.NaN;
  const migrated: Record<string, unknown> = {
    ...record,
    engineId: record.engineId ?? engineId,
    estimatedProbability: probability,
    wilsonUpperBound: upperBound,
    expectedValue: record.expectedValue ?? null,
    observedTicks,
    squaredProbabilityError,
  };
  return isPredictionOutcomeRecord(migrated) ? migrated : null;
}

export function parsePerformanceHistory(value: unknown): PredictionOutcomeRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(migratePerformanceRecord)
    .filter((record): record is PredictionOutcomeRecord => record !== null)
    .map((record) => record.status === 'tracking'
      ? { ...record, status: 'interrupted' }
      : record);
}

export function summarizePerformance(
  outcomes: readonly PredictionOutcomeRecord[],
): MarketContractPerformance[] {
  const summaries = new Map<string, MarketContractPerformance>();

  for (const outcome of outcomes) {
    const key = `${outcome.engineId}\u0000${outcome.marketSymbol}\u0000${outcome.contractType}`;
    const summary = summaries.get(key) ?? {
      engineId: outcome.engineId,
      marketSymbol: outcome.marketSymbol,
      marketLabel: outcome.marketLabel,
      contractType: outcome.contractType,
      signalCount: 0,
      observedTicks: 0,
      wins: 0,
      losses: 0,
      accuracy: null,
      brierScore: null,
      expectedValue: null,
    };
    summary.signalCount += 1;
    summary.observedTicks += outcome.observedTicks;
    summary.wins += outcome.wins;
    summary.losses += outcome.losses;
    summary.brierScore = (summary.brierScore ?? 0) + outcome.squaredProbabilityError;
    summaries.set(key, summary);
  }

  return [...summaries.values()]
    .map((summary) => ({
      ...summary,
      accuracy: summary.observedTicks > 0 ? summary.wins / summary.observedTicks : null,
      brierScore: summary.observedTicks > 0
        ? (summary.brierScore ?? 0) / summary.observedTicks
        : null,
    }))
    .sort((left, right) => (
      right.observedTicks - left.observedTicks
      || left.marketLabel.localeCompare(right.marketLabel)
      || left.contractType.localeCompare(right.contractType)
    ));
}
