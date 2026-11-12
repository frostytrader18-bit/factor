import type { ContractType } from './analysis-engine';
import type { PredictionOutcomeStart } from './performance';

export type MultiplierLevel = 1 | 2 | 3;

export type SignalTradingSettings = {
  armed: boolean;
  stake: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  martingaleEnabled: boolean;
  multiplierLevel: MultiplierLevel;
  martingaleFactor: number | null;
  sessionProfit: number;
};

export const DEFAULT_SIGNAL_TRADING_SETTINGS: SignalTradingSettings = {
  armed: false,
  stake: 1,
  takeProfit: 10,
  stopLoss: 5,
  martingaleEnabled: false,
  multiplierLevel: 1,
  martingaleFactor: null,
  sessionProfit: 0,
};

export type DerivSignalTrade = {
  contractType: ContractType;
  signalKey: string;
  marketSymbol: string;
  digit: number | null;
  stake: number;
  takeProfit: number;
  stopLoss: number;
  martingaleEnabled: boolean;
  strategy: MultiplierLevel;
  martingaleFactor: number | null;
};

export function parseSignalTradingSettings(value: unknown): SignalTradingSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Record<string, unknown>;
  const multiplierLevel = parsed.multiplierLevel;
  const legacyMultipliers = parsed.multipliers;
  const legacyFactor = Array.isArray(legacyMultipliers) && (
    multiplierLevel === 1 || multiplierLevel === 2 || multiplierLevel === 3
  )
    ? legacyMultipliers[multiplierLevel - 1]
    : null;
  const martingaleFactor = parsed.martingaleFactor ?? legacyFactor;
  const stake = parsed.stake;
  const takeProfit = parsed.takeProfit;
  const stopLoss = parsed.stopLoss;
  const sessionProfit = parsed.sessionProfit ?? 0;
  if (
    (multiplierLevel !== 1 && multiplierLevel !== 2 && multiplierLevel !== 3)
    || !(martingaleFactor === null || (typeof martingaleFactor === 'number'
      && Number.isFinite(martingaleFactor) && martingaleFactor >= 1 && martingaleFactor <= 100))
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
    martingaleEnabled: typeof parsed.martingaleEnabled === 'boolean'
      ? parsed.martingaleEnabled
      : false,
    multiplierLevel,
    martingaleFactor: martingaleFactor as number | null,
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
  return {
    contractType: prediction.contractType,
    signalKey: prediction.signalKey,
    marketSymbol: prediction.marketSymbol,
    digit: prediction.digit,
    stake: settings.stake,
    takeProfit: settings.takeProfit,
    stopLoss: settings.stopLoss,
    martingaleEnabled: settings.martingaleEnabled,
    strategy: settings.multiplierLevel,
    martingaleFactor: settings.martingaleEnabled ? settings.martingaleFactor : null,
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
