import type { ContractType } from './analysis-engine';
import type { PredictionOutcomeStart } from './performance';

export type MultiplierLevel = 1 | 2 | 3;

export type SignalTradingSettings = {
  armed: boolean;
  stake: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  multiplierLevel: MultiplierLevel;
  multipliers: [number | null, number | null, number | null];
  sessionProfit: number;
};

export const DEFAULT_SIGNAL_TRADING_SETTINGS: SignalTradingSettings = {
  armed: false,
  stake: 1,
  takeProfit: 10,
  stopLoss: 5,
  multiplierLevel: 1,
  multipliers: [null, null, null],
  sessionProfit: 0,
};

export type DerivSignalTrade = {
  contractType: ContractType;
  signalKey: string;
  marketSymbol: string;
  digit: number | null;
  stake: number;
  multiplier: number | null;
  takeProfit: number;
  stopLoss: number;
  sessionProfit: number;
};

export function parseSignalTradingSettings(value: unknown): SignalTradingSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Record<string, unknown>;
  const multipliers = parsed.multipliers;
  if (!Array.isArray(multipliers) || multipliers.length !== 3) return null;

  const parsedMultipliers = multipliers.map((multiplier) => (
    multiplier === null || multiplier === ''
      ? null
      : typeof multiplier === 'number' && Number.isFinite(multiplier)
        && multiplier >= 1 && multiplier <= 100
        ? multiplier
        : Number.NaN
  ));
  const multiplierLevel = parsed.multiplierLevel;
  const stake = parsed.stake;
  const takeProfit = parsed.takeProfit;
  const stopLoss = parsed.stopLoss;
  const sessionProfit = parsed.sessionProfit ?? 0;
  if (
    parsedMultipliers.some((multiplier) => typeof multiplier === 'number' && !Number.isFinite(multiplier))
    || (multiplierLevel !== 1 && multiplierLevel !== 2 && multiplierLevel !== 3)
    || !(stake === null || (typeof stake === 'number' && Number.isFinite(stake) && stake > 0 && stake <= 10000))
    || !(takeProfit === null || (typeof takeProfit === 'number'
      && Number.isFinite(takeProfit) && takeProfit > 0 && takeProfit <= 1000000))
    || !(stopLoss === null || (typeof stopLoss === 'number'
      && Number.isFinite(stopLoss) && stopLoss > 0 && stopLoss <= 1000000))
    || typeof sessionProfit !== 'number' || !Number.isFinite(sessionProfit)
    || typeof parsed.armed !== 'boolean'
  ) {
    return null;
  }

  return {
    armed: parsed.armed,
    stake,
    takeProfit,
    stopLoss,
    multiplierLevel,
    multipliers: parsedMultipliers as SignalTradingSettings['multipliers'],
    sessionProfit,
  };
}

export function createDerivSignalTrade(
  prediction: PredictionOutcomeStart,
  settings: SignalTradingSettings,
): DerivSignalTrade {
  if (settings.stake === null || settings.takeProfit === null || settings.stopLoss === null) {
    throw new Error('Enter a stake, take-profit, and stop-loss amount before trading.');
  }
  const multiplier = settings.multipliers[settings.multiplierLevel - 1];
  return {
    contractType: prediction.contractType,
    signalKey: prediction.signalKey,
    marketSymbol: prediction.marketSymbol,
    digit: prediction.digit,
    stake: settings.stake * (multiplier ?? 1),
    multiplier,
    takeProfit: settings.takeProfit,
    stopLoss: settings.stopLoss,
    sessionProfit: settings.sessionProfit,
  };
}

export function hasReachedSessionLimit(
  sessionProfit: number,
  takeProfit: number | null,
  stopLoss: number | null,
) {
  return takeProfit !== null && stopLoss !== null
    && (sessionProfit >= takeProfit || sessionProfit <= -stopLoss);
}
