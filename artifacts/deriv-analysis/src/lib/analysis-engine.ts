import {
  DEFAULT_ANALYSIS_ENGINE_CONFIGURATIONS,
  createContractAnalysisEngine,
  isContractWin,
  type AnalysisEngineConfiguration,
  type AnalysisEngineId,
  type EngineSignalStatus,
} from './contract-engines.ts';

export { isContractWin } from './contract-engines.ts';

export type LiveTick = {
  price: string;
  digit: number;
  epoch?: number;
  symbol?: string;
};

export type ContractType = 'match-digit' | 'differ' | 'over' | 'under' | 'even-odd';

export type ScannedMarket = {
  symbol: string;
  label: string;
  ticks: LiveTick[];
  tickVersion: number;
};

export type ContractSignal = {
  signalKey: string;
  signalLabel: string;
  digit: number | null;
  baselineRate: number;
  recentOccurrences: number;
  recentSampleSize: number;
  analyzedTickCount: number;
  analyzedWindowOccurrences: number;
};

export type MarketCandidate = ScannedMarket & ContractSignal & {
  engineId: AnalysisEngineId;
  analyzedTicks: LiveTick[];
  freshTickCount: number;
  backtestHits: number;
  backtestPredictions: number;
  backtestAccuracy: number;
  wilsonLowerBound: number;
  wilsonUpperBound: number;
  estimatedProbability: number;
  expectedValue: number | null;
  status: EngineSignalStatus;
  rejectionReason: string | null;
  isValidated: boolean;
};

export type WalkForwardResults = {
  predictions: number;
  signalResults: Map<string, { hits: number; predictions: number }>;
};

export const MIN_TRAINING_TICKS = 100;
export const MIN_OUT_OF_SAMPLE_CALLS = 300;
export const SCANNER_PRIOR_TICK_COUNT = 100;
export const FRESH_SCAN_TICK_COUNT = 10;
const MIN_SIGNAL_TEST_CALLS = 30;
const BACKTEST_LIMIT = 700;
export const RECENT_ANALYSIS_TICKS = 20;
export const RECENT_DIGIT_WINDOW = 10;
const FAMILYWISE_ERROR_RATE = 0.05;

export function getContractSignal(
  ticks: LiveTick[],
  contractType: ContractType,
  _signalWindowSize = RECENT_DIGIT_WINDOW,
  configuration?: Partial<AnalysisEngineConfiguration>,
): ContractSignal | null {
  return createContractAnalysisEngine(contractType, configuration).getSignal(ticks);
}

export function getWalkForwardResults(
  ticks: LiveTick[],
  contractType: ContractType,
  configuration?: Partial<AnalysisEngineConfiguration>,
): WalkForwardResults {
  const engine = createContractAnalysisEngine(contractType, configuration);
  const firstTestIndex = Math.max(
    MIN_TRAINING_TICKS,
    engine.analysisWindow,
    ticks.length - BACKTEST_LIMIT,
  );
  let predictions = 0;
  const signalResults = new Map<string, { hits: number; predictions: number }>();

  for (let index = firstTestIndex; index < ticks.length; index += 1) {
    const candidate = engine.getSignal(ticks.slice(0, index));
    if (!candidate) continue;

    const result = signalResults.get(candidate.signalKey) ?? { hits: 0, predictions: 0 };
    predictions += 1;
    result.predictions += 1;
    if (engine.isWin(candidate.signalKey, ticks[index].digit)) {
      result.hits += 1;
    }
    signalResults.set(candidate.signalKey, result);
  }

  return { predictions, signalResults };
}

export function wilsonInterval(hits: number, predictions: number, zScore: number) {
  if (predictions <= 0 || !Number.isFinite(zScore) || zScore <= 0) {
    return { lower: 0, upper: 1 };
  }
  const accuracy = hits / predictions;
  const zSquared = zScore * zScore;
  const denominator = 1 + zSquared / predictions;
  const center = accuracy + zSquared / (2 * predictions);
  const margin = zScore * Math.sqrt(
    (accuracy * (1 - accuracy) + zSquared / (4 * predictions)) / predictions,
  );
  return {
    lower: Math.max(0, Math.min(1, (center - margin) / denominator)),
    upper: Math.max(0, Math.min(1, (center + margin) / denominator)),
  };
}

export function wilsonLowerBound(hits: number, predictions: number, zScore: number) {
  return wilsonInterval(hits, predictions, zScore).lower;
}

function inverseNormalCdf(probability: number) {
  if (probability <= 0 || probability >= 1) {
    throw new RangeError('Probability must be greater than 0 and less than 1.');
  }

  const a = [
    -3.969683028665376e+1,
    2.209460984245205e+2,
    -2.759285104469687e+2,
    1.383577518672690e+2,
    -3.066479806614716e+1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e+1,
    1.615858368580409e+2,
    -1.556989798598866e+2,
    6.680131188771972e+1,
    -1.328068155288572e+1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const tailThreshold = 0.02425;

  if (probability < tailThreshold) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  if (probability > 1 - tailThreshold) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function getTestedSignalCount(
  contractType: ContractType,
  configuration: AnalysisEngineConfiguration,
) {
  if ((contractType === 'match-digit' || contractType === 'differ')
    && configuration.targetDigit !== null) return 1;
  if (contractType === 'even-odd' && configuration.parity !== 'auto') return 1;
  return contractType === 'match-digit' || contractType === 'differ'
    ? 10
    : contractType === 'even-odd'
      ? 2
      : 1;
}

export function multipleTestingZScore(testCount: number) {
  if (!Number.isInteger(testCount) || testCount < 1) {
    throw new RangeError('The number of simultaneous signal tests must be a positive integer.');
  }
  return inverseNormalCdf(1 - FAMILYWISE_ERROR_RATE / testCount);
}

export function scanMarkets(
  markets: ScannedMarket[],
  contractType: ContractType,
  scanTicksByMarket: Map<string, LiveTick[]>,
  configuration?: Partial<AnalysisEngineConfiguration>,
): MarketCandidate[] {
  const normalizedConfiguration: AnalysisEngineConfiguration = {
    ...DEFAULT_ANALYSIS_ENGINE_CONFIGURATIONS[
      contractType === 'match-digit' || contractType === 'differ'
        ? 'matches-differs'
        : contractType === 'over' || contractType === 'under'
          ? 'over-under'
          : 'even-odd'
    ],
    ...configuration,
    barrier: configuration?.barrier ?? (contractType === 'under' ? 6 : 3),
  };
  const hypothesisCount = Math.max(
    1,
    markets.length * getTestedSignalCount(contractType, normalizedConfiguration),
  );
  const zScore = multipleTestingZScore(hypothesisCount);

  return markets
    .flatMap((market) => {
      const scanTicks = scanTicksByMarket.get(market.symbol) ?? [];
      if (scanTicks.length > market.ticks.length) {
        return [];
      }

      const historicalTicks = market.ticks.slice(0, market.ticks.length - scanTicks.length);
      if (historicalTicks.length === 0 && scanTicks.length === 0) return [];
      const candidateConfigurations = contractType === 'differ'
        && normalizedConfiguration.targetDigit === null
        ? Array.from({ length: 10 }, (_, targetDigit) => ({
          ...normalizedConfiguration,
          targetDigit,
        }))
        : [normalizedConfiguration];

      return candidateConfigurations.flatMap((candidateConfiguration) => {
        const freshTicks = scanTicks.slice(-FRESH_SCAN_TICK_COUNT);
        const priorTicks = historicalTicks.slice(-candidateConfiguration.signalWindow);
        const decisionTicks = [...priorTicks, ...freshTicks];
        const decisionConfiguration = {
          ...candidateConfiguration,
          signalWindow: Math.min(
            1000,
            candidateConfiguration.signalWindow + freshTicks.length,
          ),
        };
        const engine = createContractAnalysisEngine(contractType, decisionConfiguration);
        const backtest = getWalkForwardResults(historicalTicks, contractType, decisionConfiguration);
        const recentCandidate = engine.getSignal(decisionTicks);
        if (!recentCandidate) return [];

        const result = backtest.signalResults.get(recentCandidate.signalKey)
          ?? { hits: 0, predictions: 0 };

        const backtestAccuracy = result.predictions > 0
          ? result.hits / result.predictions
          : 0;
        const interval = wilsonInterval(result.hits, result.predictions, zScore);
        const isValidated = freshTicks.length === FRESH_SCAN_TICK_COUNT
          && backtest.predictions >= MIN_OUT_OF_SAMPLE_CALLS
          && result.predictions >= MIN_SIGNAL_TEST_CALLS
          && interval.lower > recentCandidate.baselineRate;
        const status: EngineSignalStatus = isValidated
          ? 'VALID SIGNAL'
          : 'WEAK SIGNAL';
        return [{
          ...market,
          ...recentCandidate,
          engineId: engine.id,
          analyzedTicks: decisionTicks.slice(-recentCandidate.analyzedTickCount),
          freshTickCount: freshTicks.length,
          backtestHits: result.hits,
          backtestPredictions: result.predictions,
          backtestAccuracy,
          wilsonLowerBound: interval.lower,
          wilsonUpperBound: interval.upper,
          estimatedProbability: result.predictions > 0
            ? backtestAccuracy
            : recentCandidate.baselineRate,
          expectedValue: null,
          status,
          rejectionReason: isValidated
            ? null
            : 'The confidence interval does not establish an edge above the baseline.',
          isValidated,
        }];
      });
    })
    .sort((left, right) => (
      Number(right.isValidated) - Number(left.isValidated)
      || (right.wilsonLowerBound - right.baselineRate) - (left.wilsonLowerBound - left.baselineRate)
      || right.backtestPredictions - left.backtestPredictions
      || right.backtestAccuracy - left.backtestAccuracy
      || right.recentOccurrences / right.recentSampleSize - left.recentOccurrences / left.recentSampleSize
    ));
}
