import type { ContractSignal, ContractType, LiveTick } from './analysis-engine.ts';

export type AnalysisEngineId = 'matches-differs' | 'over-under' | 'even-odd';
export type EngineSignalStatus =
  | 'ANALYZING'
  | 'VALID SIGNAL'
  | 'WEAK SIGNAL'
  | 'NO TRADE'
  | 'INSUFFICIENT DATA'
  | 'DATA ERROR';

export type ContractAnalysisEngine = {
  id: AnalysisEngineId;
  contractType: ContractType;
  baselineRate: number;
  analysisWindow: number;
  getSignal: (ticks: LiveTick[]) => ContractSignal | null;
  isWin: (signalKey: string, digit: number) => boolean;
};

export const MATCH_EXECUTION_DELAY_TICKS = 3;

export type AnalysisEngineConfiguration = {
  signalWindow: number;
  targetDigit: number | null;
  barrier: number;
  parity: 'auto' | 'even' | 'odd';
};

export const DEFAULT_ANALYSIS_ENGINE_CONFIGURATIONS: Record<AnalysisEngineId, AnalysisEngineConfiguration> = {
  'matches-differs': { signalWindow: 100, targetDigit: null, barrier: 3, parity: 'auto' },
  'over-under': { signalWindow: 200, targetDigit: null, barrier: 3, parity: 'auto' },
  'even-odd': { signalWindow: 200, targetDigit: null, barrier: 3, parity: 'auto' },
};

const DIGIT_COUNT = 10;

function isValidDigit(digit: number): boolean {
  return Number.isInteger(digit) && digit >= 0 && digit < DIGIT_COUNT;
}

function countValidDigits(ticks: readonly LiveTick[]) {
  const counts = Array<number>(DIGIT_COUNT).fill(0);
  for (const tick of ticks) {
    if (!isValidDigit(tick.digit)) {
      return null;
    }
    counts[tick.digit] += 1;
  }
  return counts;
}

function getTransitionPrediction(
  ticks: readonly LiveTick[],
  horizon: number,
) {
  const counts = Array<number>(DIGIT_COUNT).fill(0);
  const weights = Array<number>(DIGIT_COUNT).fill(0);
  const mostRecentTransition = Array<number>(DIGIT_COUNT).fill(-1);
  let support = 0;
  const currentDigit = ticks.at(-1)?.digit;
  if (currentDigit === undefined || !isValidDigit(currentDigit)) return null;

  for (let index = ticks.length - horizon - 1; index >= 0; index -= 1) {
    const sourceDigit = ticks[index].digit;
    const nextDigit = ticks[index + horizon].digit;
    if (!isValidDigit(sourceDigit) || !isValidDigit(nextDigit)) return null;
    if (sourceDigit !== currentDigit) continue;

    counts[nextDigit] += 1;
    weights[nextDigit] += 0.97 ** (ticks.length - horizon - 1 - index);
    if (mostRecentTransition[nextDigit] === -1) {
      mostRecentTransition[nextDigit] = index;
    }
    support += 1;
  }

  if (support === 0) {
    const lastObservedDigit = ticks.at(-1)?.digit;
    if (lastObservedDigit === undefined || !isValidDigit(lastObservedDigit)) return null;
    if (ticks.length < 2) {
      return {
        currentDigit,
        predictedDigit: (lastObservedDigit + 1) % DIGIT_COUNT,
        matchingTransitions: 0,
        transitionSupport: 0,
      };
    }

    return {
      currentDigit,
      predictedDigit: ticks.at(-1)!.digit,
      matchingTransitions: 0,
      transitionSupport: 0,
    };
  }

  let predictedDigit = -1;
  let highestWeight = -1;
  let latestTransitionIndex = -1;
  for (let digit = 0; digit < DIGIT_COUNT; digit += 1) {
    if (weights[digit] > highestWeight
      || (weights[digit] === highestWeight
        && mostRecentTransition[digit] > latestTransitionIndex)) {
      highestWeight = weights[digit];
      latestTransitionIndex = mostRecentTransition[digit];
      predictedDigit = digit;
    }
  }

  return {
    currentDigit,
    predictedDigit,
    matchingTransitions: counts[predictedDigit],
    transitionSupport: support,
  };
}

function buildSignal(
  ticks: LiveTick[],
  analysisWindow: number,
  signalKey: string,
  signalLabel: string,
  digit: number | null,
  baselineRate: number,
  isWin: (signalKey: string, digit: number) => boolean,
): ContractSignal | null {
  const analysisTicks = ticks.slice(-analysisWindow);
  if (analysisTicks.length === 0) return null;
  const validDigits = analysisTicks.filter((tick) => isValidDigit(tick.digit));
  if (validDigits.length !== analysisTicks.length) return null;

  const recentTicks = analysisTicks.slice(-20);
  return {
    signalKey,
    signalLabel,
    digit,
    baselineRate,
    recentOccurrences: recentTicks.filter((tick) => isWin(signalKey, tick.digit)).length,
    recentSampleSize: recentTicks.length,
    analyzedTickCount: analysisTicks.length,
    analyzedWindowOccurrences: analysisTicks.filter((tick) => isWin(signalKey, tick.digit)).length,
  };
}

export function isContractWin(
  contractType: ContractType,
  signalKey: string,
  signalDigit: number | null,
  digit: number,
): boolean {
  if (!isValidDigit(digit)) return false;
  switch (contractType) {
    case 'match-digit':
      return signalDigit !== null && digit === signalDigit;
    case 'differ':
      return signalDigit !== null && digit !== signalDigit;
    case 'over':
      return signalDigit !== null && digit > signalDigit;
    case 'under':
      return signalDigit !== null && digit < signalDigit;
    case 'even-odd':
      return signalKey === (digit % 2 === 0 ? 'even' : 'odd');
  }
  return false;
}

function createMatchesDiffersEngine(
  contractType: 'match-digit' | 'differ',
  configuration: AnalysisEngineConfiguration,
): ContractAnalysisEngine {
  const analysisWindow = configuration.signalWindow;
  const baselineRate = contractType === 'match-digit' ? 0.1 : 0.9;
  const isWin = (signalKey: string, digit: number) => (
    isContractWin(contractType, signalKey, Number(signalKey), digit)
  );

  return {
    id: 'matches-differs',
    contractType,
    baselineRate,
    analysisWindow,
    getSignal(ticks) {
      const analysisTicks = ticks.slice(-analysisWindow);
      if (analysisTicks.length === 0) return null;
      let targetDigit = configuration.targetDigit;
      let transitionPrediction: ReturnType<typeof getTransitionPrediction> = null;
      if (contractType === 'match-digit' && targetDigit === null) {
        transitionPrediction = getTransitionPrediction(
          analysisTicks,
          MATCH_EXECUTION_DELAY_TICKS,
        );
        if (!transitionPrediction) return null;
        targetDigit = transitionPrediction.predictedDigit;
      } else if (targetDigit === null) {
        const counts = countValidDigits(analysisTicks);
        if (!counts) return null;
        targetDigit = counts.reduce((best, count, digit) => (
          count > counts[best] ? digit : best
        ), analysisTicks.at(-1)!.digit);
      }
      const signalKey = String(targetDigit);
      const label = contractType === 'match-digit' ? `MATCH ${targetDigit}` : `DIFFERS FROM ${targetDigit}`;
      const signal = buildSignal(
        ticks,
        analysisWindow,
        signalKey,
        label,
        targetDigit,
        baselineRate,
        isWin,
      );
      if (signal && transitionPrediction) {
        return {
          ...signal,
          recentOccurrences: transitionPrediction.matchingTransitions,
          recentSampleSize: transitionPrediction.transitionSupport,
        };
      }
      return signal;
    },
    isWin,
  };
}

function createOverUnderEngine(
  contractType: 'over' | 'under',
  configuration: AnalysisEngineConfiguration,
): ContractAnalysisEngine {
  const barrier = configuration.barrier;
  if (!Number.isInteger(barrier) || barrier < 0 || barrier > 9) {
    throw new RangeError('The over/under barrier must be a digit from 0 to 9.');
  }
  const analysisWindow = configuration.signalWindow;
  const baselineRate = contractType === 'over'
    ? (9 - barrier) / DIGIT_COUNT
    : barrier / DIGIT_COUNT;
  const signalKey = `${contractType}-${barrier}`;
  const signalLabel = `${contractType.toUpperCase()} ${barrier}`;
  const isWin = (_signalKey: string, digit: number) => (
    isContractWin(contractType, signalKey, barrier, digit)
  );

  return {
    id: 'over-under',
    contractType,
    baselineRate,
    analysisWindow,
    getSignal(ticks) {
      if (!countValidDigits(ticks.slice(-analysisWindow))) return null;
      return buildSignal(
        ticks,
        analysisWindow,
        signalKey,
        signalLabel,
        barrier,
        baselineRate,
        isWin,
      );
    },
    isWin,
  };
}

function createEvenOddEngine(
  contractType: 'even-odd',
  configuration: AnalysisEngineConfiguration,
): ContractAnalysisEngine {
  const analysisWindow = configuration.signalWindow;
  const baselineRate = 0.5;
  const isWin = (signalKey: string, digit: number) => (
    isContractWin(contractType, signalKey, null, digit)
  );

  return {
    id: 'even-odd',
    contractType,
    baselineRate,
    analysisWindow,
    getSignal(ticks) {
      const analysisTicks = ticks.slice(-analysisWindow);
      if (!countValidDigits(analysisTicks) || analysisTicks.length === 0) return null;
      const evenCount = analysisTicks.filter((tick) => tick.digit % 2 === 0).length;
      const evenProbability = evenCount / analysisTicks.length;
      if (evenProbability === baselineRate && configuration.parity === 'auto') return null;
      const signalKey = configuration.parity === 'auto'
        ? evenProbability > baselineRate ? 'even' : 'odd'
        : configuration.parity;
      return buildSignal(
        ticks,
        analysisWindow,
        signalKey,
        signalKey.toUpperCase(),
        null,
        baselineRate,
        isWin,
      );
    },
    isWin,
  };
}

export function createContractAnalysisEngine(
  contractType: ContractType,
  configuration?: Partial<AnalysisEngineConfiguration>,
): ContractAnalysisEngine {
  const engineId: AnalysisEngineId = contractType === 'match-digit' || contractType === 'differ'
    ? 'matches-differs'
    : contractType === 'over' || contractType === 'under'
      ? 'over-under'
      : 'even-odd';
  const normalizedConfiguration: AnalysisEngineConfiguration = {
    ...DEFAULT_ANALYSIS_ENGINE_CONFIGURATIONS[engineId],
    ...configuration,
    barrier: configuration?.barrier ?? (contractType === 'under' ? 6 : 3),
  };
  if (!Number.isInteger(normalizedConfiguration.signalWindow)
    || normalizedConfiguration.signalWindow < 20
    || normalizedConfiguration.signalWindow > 1000) {
    throw new RangeError('The analysis window must be between 20 and 1,000 ticks.');
  }
  if (normalizedConfiguration.targetDigit !== null
    && (!Number.isInteger(normalizedConfiguration.targetDigit)
      || normalizedConfiguration.targetDigit < 0
      || normalizedConfiguration.targetDigit > 9)) {
    throw new RangeError('The target digit must be between 0 and 9.');
  }
  if (normalizedConfiguration.parity !== 'auto'
    && normalizedConfiguration.parity !== 'even'
    && normalizedConfiguration.parity !== 'odd') {
    throw new RangeError('The selected parity must be auto, even, or odd.');
  }

  switch (contractType) {
    case 'match-digit':
    case 'differ':
      return createMatchesDiffersEngine(contractType, normalizedConfiguration);
    case 'over':
      return createOverUnderEngine('over', normalizedConfiguration);
    case 'under':
      return createOverUnderEngine('under', normalizedConfiguration);
    case 'even-odd':
      return createEvenOddEngine(contractType, normalizedConfiguration);
  }
  return assertNever(contractType);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported contract analysis engine: ${String(value)}`);
}

export function isEngineSignalReady(
  engine: ContractAnalysisEngine,
  ticks: readonly LiveTick[],
): boolean {
  const sample = ticks.slice(-engine.analysisWindow);
  return sample.length === engine.analysisWindow
    && countValidDigits(sample) !== null;
}
