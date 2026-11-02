import { useEffect, useRef, useState } from 'react';
import { Activity, Clock3, ShieldCheck, Signal, Target, Wifi } from 'lucide-react';

type LiveTick = {
  price: string;
  digit: number;
};

type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'error';
export type ContractType = 'match-digit' | 'differ' | 'over' | 'under' | 'even-odd';

type ContractSignal = {
  signalKey: string;
  signalLabel: string;
  digit: number | null;
  baselineRate: number;
  recentOccurrences: number;
  recentSampleSize: number;
  analyzedTickCount: number;
  analyzedWindowOccurrences: number;
};

type ScannedMarket = {
  symbol: string;
  label: string;
  ticks: LiveTick[];
  tickVersion: number;
};

type MarketCandidate = ScannedMarket & ContractSignal & {
  scanTicks: LiveTick[];
  backtestHits: number;
  backtestPredictions: number;
  backtestAccuracy: number;
  wilsonLowerBound: number;
};

type ActivePrediction = ContractSignal & {
  contractType: ContractType;
  marketSymbol: string;
  marketLabel: string;
  analyzedTicks: LiveTick[];
  backtestHits: number;
  backtestPredictions: number;
  backtestAccuracy: number;
  wilsonLowerBound: number;
  expiresAt: number;
};

export type PredictionOutcomeStart = Pick<
  ActivePrediction,
  'contractType' | 'signalKey' | 'signalLabel' | 'digit' | 'marketSymbol' | 'marketLabel' | 'expiresAt'
> & {
  id: string;
  startedAt: number;
};

type DigitScannerViewProps = {
  markets: ScannedMarket[];
  contractType: ContractType;
  feedStatus: FeedStatus;
  feedError: string | null;
  onMarketSelect: (symbol: string) => void;
  onPredictionStart: (prediction: PredictionOutcomeStart) => void;
};

const DIGIT_COUNT = 10;
const BASE_RATE = 1 / DIGIT_COUNT;
const MIN_TRAINING_TICKS = 100;
const MIN_OUT_OF_SAMPLE_CALLS = 100;
const MIN_DIGIT_TEST_CALLS = 10;
const MIN_FRESH_SCAN_TICKS = 1;
const BACKTEST_LIMIT = 250;
const RECENT_ANALYSIS_TICKS = 20;
const RECENT_DIGIT_WINDOW = 10;
const SCANNER_COUNTDOWN_SECONDS = 10;
const PREDICTION_VALIDITY_SECONDS = 30;

type OverUnderStrategy = {
  direction: 'over' | 'under';
  barrier: number;
  baselineRate: number;
};

export function isContractWin(
  contractType: ContractType,
  signalKey: string,
  signalDigit: number | null,
  digit: number,
) {
  switch (contractType) {
    case 'match-digit':
      return digit === signalDigit;
    case 'differ':
      return digit !== signalDigit;
    case 'over':
      return digit > (signalDigit ?? 9);
    case 'under':
      return digit < (signalDigit ?? 0);
    case 'even-odd':
      return signalKey === (digit % 2 === 0 ? 'even' : 'odd');
  }
  return false;
}

function getOverUnderStrategy(contractType: ContractType): OverUnderStrategy | null {
  if (contractType === 'over') {
    return { direction: 'over', barrier: 3, baselineRate: 0.6 };
  }
  if (contractType === 'under') {
    return { direction: 'under', barrier: 6, baselineRate: 0.6 };
  }
  return null;
}

function getContractSignal(
  ticks: LiveTick[],
  contractType: ContractType,
  overUnderStrategy: OverUnderStrategy | null,
  signalWindowSize = RECENT_DIGIT_WINDOW,
): ContractSignal | null {
  const analysisTicks = ticks.slice(-RECENT_ANALYSIS_TICKS);
  const recentTicks = analysisTicks.slice(-signalWindowSize);
  if (recentTicks.length === 0) {
    return null;
  }

  let signalKey: string;
  let signalLabel: string;
  let digit: number | null;
  let baselineRate: number;
  if (contractType === 'match-digit' || contractType === 'differ') {
    const counts = Array(DIGIT_COUNT).fill(0) as number[];
    for (const tick of recentTicks) counts[tick.digit] += 1;
    digit = recentTicks[recentTicks.length - 1].digit;
    for (const tick of recentTicks) {
      if (counts[tick.digit] > counts[digit]) digit = tick.digit;
    }
    signalKey = String(digit);
    signalLabel = contractType === 'match-digit' ? `MATCH ${digit}` : `DIFFERS FROM ${digit}`;
    baselineRate = contractType === 'match-digit' ? BASE_RATE : 1 - BASE_RATE;
  } else if (contractType === 'even-odd') {
    const evenCount = recentTicks.filter((tick) => tick.digit % 2 === 0).length;
    const latestParity = recentTicks[recentTicks.length - 1].digit % 2 === 0 ? 'even' : 'odd';
    signalKey = evenCount * 2 === recentTicks.length ? latestParity : evenCount * 2 > recentTicks.length ? 'even' : 'odd';
    signalLabel = signalKey.toUpperCase();
    digit = null;
    baselineRate = 0.5;
  } else {
    if (!overUnderStrategy) return null;
    signalKey = `${overUnderStrategy.direction}-${overUnderStrategy.barrier}`;
    signalLabel = `${overUnderStrategy.direction.toUpperCase()} ${overUnderStrategy.barrier}`;
    digit = overUnderStrategy.barrier;
    baselineRate = overUnderStrategy.baselineRate;
  }

  const signalBase = { signalKey, signalLabel, digit, baselineRate };
  return {
    ...signalBase,
    recentOccurrences: recentTicks.filter((tick) => isContractWin(contractType, signalKey, digit, tick.digit)).length,
    recentSampleSize: recentTicks.length,
    analyzedTickCount: analysisTicks.length,
    analyzedWindowOccurrences: analysisTicks.filter((tick) => isContractWin(contractType, signalKey, digit, tick.digit)).length,
  };
}

function getWalkForwardResults(
  ticks: LiveTick[],
  contractType: ContractType,
  overUnderStrategy: OverUnderStrategy | null,
  signalWindowSize = RECENT_DIGIT_WINDOW,
) {
  const firstTestIndex = Math.max(MIN_TRAINING_TICKS, ticks.length - BACKTEST_LIMIT);
  let predictions = 0;
  const signalResults = new Map<string, { hits: number; predictions: number }>();

  for (let index = firstTestIndex; index < ticks.length; index += 1) {
    const candidate = getContractSignal(ticks.slice(0, index), contractType, overUnderStrategy, signalWindowSize);
    if (!candidate) continue;

    const result = signalResults.get(candidate.signalKey) ?? { hits: 0, predictions: 0 };
    predictions += 1;
    result.predictions += 1;
    if (isContractWin(contractType, candidate.signalKey, candidate.digit, ticks[index].digit)) result.hits += 1;
    signalResults.set(candidate.signalKey, result);
  }

  return { predictions, signalResults };
}

function formatPercent(value: number | null) {
  return value === null ? '--' : `${(value * 100).toFixed(1)}%`;
}

function formatCountdown(seconds: number) {
  return seconds.toString().padStart(2, '0');
}

function scanMarkets(
  markets: ScannedMarket[],
  contractType: ContractType,
  scanTicksByMarket: Map<string, LiveTick[]>,
): MarketCandidate[] {
  return markets
    .flatMap((market) => {
      const scanTicks = scanTicksByMarket.get(market.symbol);
      if (!scanTicks || scanTicks.length < MIN_FRESH_SCAN_TICKS) {
        return [];
      }
      if (market.ticks.length < MIN_TRAINING_TICKS + MIN_OUT_OF_SAMPLE_CALLS) {
        return [];
      }

      const overUnderStrategy = getOverUnderStrategy(contractType);
      const signalWindowSize = Math.min(scanTicks.length, RECENT_DIGIT_WINDOW);
      const backtest = getWalkForwardResults(market.ticks, contractType, overUnderStrategy, signalWindowSize);
      if (backtest.predictions < MIN_OUT_OF_SAMPLE_CALLS) {
        return [];
      }
      const recentCandidate = getContractSignal(scanTicks, contractType, overUnderStrategy, signalWindowSize);
      if (!recentCandidate) {
        return [];
      }
      const result = backtest.signalResults.get(recentCandidate.signalKey);
      if (!result || result.predictions < MIN_DIGIT_TEST_CALLS) {
        return [];
      }

      const accuracy = result.hits / result.predictions;
      const z = 1.96;
      const wilsonLowerBound = (
        accuracy
        + (z * z) / (2 * result.predictions)
        - z * Math.sqrt((accuracy * (1 - accuracy) + (z * z) / (4 * result.predictions)) / result.predictions)
      ) / (1 + (z * z) / result.predictions);
      if (wilsonLowerBound <= recentCandidate.baselineRate) {
        return [];
      }

      return [{
        ...market,
        scanTicks,
        ...recentCandidate,
        backtestHits: result.hits,
        backtestPredictions: result.predictions,
        backtestAccuracy: accuracy,
        wilsonLowerBound,
      }];
    })
    .sort((left, right) => (
      right.wilsonLowerBound - left.wilsonLowerBound
      || right.backtestPredictions - left.backtestPredictions
      || right.backtestAccuracy - left.backtestAccuracy
      || right.recentOccurrences / right.recentSampleSize - left.recentOccurrences / left.recentSampleSize
    ));
}

export function DigitScannerView({
  markets,
  contractType,
  feedStatus,
  feedError,
  onMarketSelect,
  onPredictionStart,
}: DigitScannerViewProps) {
  const [predictionSecondsRemaining, setPredictionSecondsRemaining] = useState(0);
  const [scanCountdownSeconds, setScanCountdownSeconds] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [activePrediction, setActivePrediction] = useState<ActivePrediction | null>(null);
  const [lastManualScan, setLastManualScan] = useState<string | null>(null);
  const [scanResults, setScanResults] = useState<MarketCandidate[] | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const marketsRef = useRef(markets);
  const scanStartTickVersionsRef = useRef(new Map<string, number>());
  const callbacksRef = useRef({ onMarketSelect, onPredictionStart });
  marketsRef.current = markets;
  callbacksRef.current = { onMarketSelect, onPredictionStart };
  const feedStatusLabel = feedStatus === 'live'
    ? 'LIVE'
    : feedStatus === 'reconnecting'
      ? 'RECONNECTING'
      : feedStatus === 'error'
        ? 'FEED ERROR'
        : 'CONNECTING';
  const totalMarkets = markets.length;
  const contractLabel = {
    'match-digit': 'MATCHES',
    differ: 'DIFFERS',
    over: 'OVER',
    under: 'UNDER',
    'even-odd': 'EVEN / ODD',
  }[contractType];
  const readyMarkets = markets.filter(
    (market) => market.ticks.length >= MIN_TRAINING_TICKS + MIN_OUT_OF_SAMPLE_CALLS,
  ).length;
  const rankedMarkets = scanResults ?? [];
  const topResult = rankedMarkets[0] ?? null;
  const predictionIsActive = feedStatus === 'live' && predictionSecondsRemaining > 0;
  const displayedPrediction = predictionIsActive ? activePrediction : null;
  const edgeValidated = displayedPrediction !== null
    && displayedPrediction.backtestPredictions >= MIN_OUT_OF_SAMPLE_CALLS
    && displayedPrediction.wilsonLowerBound > displayedPrediction.baselineRate;

  useEffect(() => {
    setActivePrediction(null);
    setPredictionSecondsRemaining(0);
    setScanResults(null);
    setScanMessage(null);
    if (isAnalyzing) {
      setIsAnalyzing(false);
      setScanCountdownSeconds(0);
    }
  }, [contractType]);

  const initiateManualScan = () => {
    if (feedStatus !== 'live' || isAnalyzing) {
      return;
    }

    setActivePrediction(null);
    setPredictionSecondsRemaining(0);
    setScanResults(null);
    scanStartTickVersionsRef.current = new Map(
      marketsRef.current.map((market) => [market.symbol, market.tickVersion]),
    );
    setScanMessage(`Collecting fresh market ticks for ${SCANNER_COUNTDOWN_SECONDS}s. Previous results are hidden until this scan completes.`);
    setScanCountdownSeconds(SCANNER_COUNTDOWN_SECONDS);
    setIsAnalyzing(true);
  };

  useEffect(() => {
    if (!isAnalyzing) {
      return;
    }

    if (feedStatus !== 'live') {
      setIsAnalyzing(false);
      setScanCountdownSeconds(0);
      setScanMessage('Scan canceled because the live feed disconnected. Reconnect and scan again.');
      return;
    }

    const deadline = Date.now() + SCANNER_COUNTDOWN_SECONDS * 1000;
    const timer = window.setInterval(() => {
      const secondsRemaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setScanCountdownSeconds(secondsRemaining);
      if (secondsRemaining === 0) {
        window.clearInterval(timer);
        setIsAnalyzing(false);
        setLastManualScan(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        const scanTicksByMarket = new Map<string, LiveTick[]>();
        for (const market of marketsRef.current) {
          const freshTickCount = market.tickVersion
            - (scanStartTickVersionsRef.current.get(market.symbol) ?? market.tickVersion);
          if (freshTickCount >= MIN_FRESH_SCAN_TICKS) {
            scanTicksByMarket.set(market.symbol, market.ticks.slice(-Math.min(freshTickCount, market.ticks.length)));
          }
        }
        const finalResults = scanMarkets(marketsRef.current, contractType, scanTicksByMarket);
        const scannedMarketCount = scanTicksByMarket.size;
        if (finalResults.length === 0) {
          setActivePrediction(null);
          setPredictionSecondsRemaining(0);
          setScanMessage(`No qualified ${contractLabel} signal. Fresh ticks: ${scanTicksByMarket.size}/${marketsRef.current.length}.`);
          return;
        }

        const topCandidate = finalResults[0];
        setScanResults(finalResults);
        setScanMessage(`Fresh ticks received from ${scannedMarketCount}/${marketsRef.current.length} markets; ranked ${finalResults.length} qualified markets by conservative walk-forward results. Historical rates are not guarantees.`);
        const startedAt = Date.now();
        const expiresAt = startedAt + PREDICTION_VALIDITY_SECONDS * 1000;
        const outcomeStart: PredictionOutcomeStart = {
          id: `${topCandidate.symbol}-${startedAt}`,
          contractType,
          signalKey: topCandidate.signalKey,
          signalLabel: topCandidate.signalLabel,
          digit: topCandidate.digit,
          marketSymbol: topCandidate.symbol,
          marketLabel: topCandidate.label,
          startedAt,
          expiresAt,
        };
        callbacksRef.current.onMarketSelect(topCandidate.symbol);
        callbacksRef.current.onPredictionStart(outcomeStart);
        setActivePrediction({
          contractType,
          signalKey: topCandidate.signalKey,
          signalLabel: topCandidate.signalLabel,
          digit: topCandidate.digit,
          baselineRate: topCandidate.baselineRate,
          recentOccurrences: topCandidate.recentOccurrences,
          recentSampleSize: topCandidate.recentSampleSize,
          analyzedTickCount: topCandidate.analyzedTickCount,
          analyzedWindowOccurrences: topCandidate.analyzedWindowOccurrences,
          analyzedTicks: topCandidate.scanTicks.slice(-RECENT_ANALYSIS_TICKS),
          marketSymbol: topCandidate.symbol,
          marketLabel: topCandidate.label,
          backtestHits: topCandidate.backtestHits,
          backtestPredictions: topCandidate.backtestPredictions,
          backtestAccuracy: topCandidate.backtestAccuracy,
          wilsonLowerBound: topCandidate.wilsonLowerBound,
          expiresAt,
        });
        setPredictionSecondsRemaining(PREDICTION_VALIDITY_SECONDS);
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [contractType, feedStatus, isAnalyzing]);

  useEffect(() => {
    if (!activePrediction || feedStatus !== 'live') {
      setPredictionSecondsRemaining(0);
      if (feedStatus !== 'live') {
        setActivePrediction(null);
      }
      return;
    }

    const updateTimer = () => {
      const now = Date.now();
      const remaining = Math.max(0, Math.ceil((activePrediction.expiresAt - now) / 1000));
      setPredictionSecondsRemaining(remaining);
      if (remaining === 0) {
        setActivePrediction(null);
      }
    };

    updateTimer();
    const timer = window.setInterval(updateTimer, 250);
    return () => window.clearInterval(timer);
  }, [activePrediction, feedStatus]);

  const topTicks = displayedPrediction?.analyzedTicks ?? topResult?.ticks.slice(-RECENT_ANALYSIS_TICKS) ?? [];
  const canScan = feedStatus === 'live' && readyMarkets > 0 && !isAnalyzing;

  return (
    <section data-testid="view-digit-scanner" className="tab-view rise-in mx-auto max-w-none min-w-0">
      <section className="relative overflow-hidden rounded-[14px] border border-[#20c9dc] bg-[#06111d] p-2 shadow-[0_0_24px_rgba(27,65,161,.16)] sm:p-3">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-[#162b61]/25 to-transparent" />
        <div className="relative z-[1] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[#245e7b] bg-[#0b1c2b] text-[#58d5e7]"><Signal size={16} /></div>
              <div className="min-w-0">
                <h1 className="font-display text-[14px] font-extrabold leading-tight tracking-[.04em] text-[#eff4ff] sm:text-[16px]">DERIV <span className="text-[#58d5e7]">MARKET SCANNER</span></h1>
                <p className="mt-1 truncate font-mono-ui text-[8px] tracking-wider text-[#8295b0]">LIVE VOLATILITY MARKET · {contractLabel} CONTRACT SCAN</p>
              </div>
            </div>
            <div data-testid="scanner-feed-status" aria-live="polite" className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 font-mono-ui text-[8px] font-bold tracking-wider ${feedStatus === 'live' ? 'border-[#147e68] bg-[#063527] text-[#57e0b0]' : 'border-[#805d26] bg-[#382b13] text-[#e0c365]'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${feedStatus === 'live' ? 'animate-pulse bg-[#42e4a4]' : 'bg-[#e2bd5c]'}`} />
              {feedStatus === 'live' ? `${readyMarkets}/${totalMarkets} MARKETS` : feedStatusLabel}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-[#128b72] bg-[#05251f] px-3 py-2 shadow-[0_0_12px_rgba(16,190,138,.12)]">
            <div className="flex min-w-0 items-center gap-2">
              <Wifi size={15} className={feedStatus === 'live' ? 'shrink-0 text-[#39dfaa]' : 'shrink-0 text-[#d7b966]'} />
              <div className="min-w-0">
                <p className="font-mono-ui text-[7px] font-bold tracking-[.12em] text-[#67bbaa]">SCANNING ALL AVAILABLE VOLATILITY MARKETS</p>
                <p className="mt-0.5 truncate text-[10px] font-extrabold text-[#dff8f5]">{totalMarkets} markets tracked · {readyMarkets} meet the minimum test-history requirement</p>
              </div>
            </div>
            <span className="shrink-0 rounded-md border border-[#175b4d] bg-[#073a2e] px-2 py-1 font-mono-ui text-[8px] font-bold text-[#69d8ca]">{feedStatus === 'live' ? 'LIVE SCAN' : feedStatusLabel}</span>
          </div>

          {feedError && <p role="alert" data-testid="scanner-feed-error" className="rounded border border-[#7f3434]/60 bg-[#381c20]/70 px-3 py-2 text-[10px] text-[#ffaaaa]">{feedError}</p>}

          <section className="rounded-lg border border-[#176a79] bg-[#091925] p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Activity size={14} className="text-[#58d5e7]" />
                <h2 className="font-mono-ui text-[9px] font-bold tracking-[.12em] text-[#8de4ec]">CROSS-MARKET · {contractLabel} SCAN</h2>
              </div>
              <button
                type="button"
                onClick={initiateManualScan}
                disabled={!canScan}
                data-testid="scanner-scan-now"
                className="flex items-center gap-1.5 rounded-md border border-[#c4a44e] bg-gradient-to-r from-[#b68a31] to-[#e0bc5c] px-3 py-1.5 font-mono-ui text-[9px] font-extrabold tracking-wider text-[#211b10] shadow-[0_3px_15px_rgba(195,155,58,.14)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Target size={12} />
                {isAnalyzing ? 'ANALYZING…' : 'SCAN NOW'}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono-ui text-[9px] text-[#98a9c2]">
                {isAnalyzing
                  ? `ANALYZING ${totalMarkets} MARKETS IN PARALLEL`
                  : displayedPrediction
                    ? `TOP ${contractLabel} PERFORMER · ${displayedPrediction.marketSymbol}`
                    : scanResults
                      ? 'SCAN COMPLETE · RUN AGAIN FOR A FRESH RESULT'
                      : 'NO MARKET PICKED · START A MANUAL SCAN'}
              </span>
              <span className="rounded-md border border-[#214c98] bg-[#102653] px-2.5 py-1 font-mono-ui text-[9px] font-bold text-[#70baff]">
                {isAnalyzing
                  ? 'LIVE ANALYSIS'
                  : displayedPrediction
                    ? `PICK EXPIRES IN ${predictionSecondsRemaining}s`
                    : feedStatusLabel}
              </span>
            </div>
            <p data-testid="scanner-last-manual-scan" aria-live="polite" className="mt-1 font-mono-ui text-[8px] text-[#8295b0]">
              {scanMessage
                ?? (lastManualScan
                  ? `Latest manual scan: ${lastManualScan}`
                  : 'Press SCAN NOW to scan markets.')}
            </p>
          </section>

          <section className="rounded-[13px] border border-[#176a79] bg-gradient-to-b from-[#0c1a28] to-[#07111b] p-2.5 shadow-[0_0_18px_rgba(32,201,220,.08)] sm:p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono-ui text-[8px] font-bold tracking-[.12em] text-[#e2bd5c]">TOP WALK-FORWARD MARKET · {contractLabel}</p>
                <h2 data-testid="scanner-selected-market" className="mt-1 text-[15px] font-extrabold leading-tight text-[#edf3ff] sm:text-[18px]">{displayedPrediction?.marketLabel.toUpperCase() ?? 'SCANNING MARKETS'}</h2>
                {displayedPrediction && <p data-testid="scanner-selected-symbol" className="mt-0.5 font-mono-ui text-[8px] font-bold text-[#72b7eb]">{displayedPrediction.marketSymbol}</p>}
              </div>
              <span data-testid="scanner-edge-badge" className={`rounded-full border px-2 py-1 font-mono-ui text-[8px] font-bold tracking-wide ${edgeValidated ? 'border-[#168a61] bg-[#073a2a] text-[#61e4aa]' : 'border-[#755f30] bg-[#302713] text-[#e0c365]'}`}>
                {edgeValidated ? 'EDGE TEST PASSED' : displayedPrediction ? 'NO VERIFIED EDGE' : 'SCAN TO SELECT'}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-lg border border-[#216caf] bg-[#08284c] px-3 py-2 shadow-[0_0_15px_rgba(27,135,255,.18)]">
                <Target size={14} className="text-[#5bbaff]" />
                <div>
                  <p className="font-mono-ui text-[7px] font-bold tracking-wider text-[#70baff]">SCAN-WINDOW CONTRACT WIN RATE</p>
                  <strong data-testid="scanner-candidate-probability" className="font-display text-[16px] font-extrabold text-[#e8f5ff]">
                    {displayedPrediction
                      ? formatPercent(displayedPrediction.recentOccurrences / displayedPrediction.recentSampleSize)
                      : '--'}
                  </strong>
                </div>
              </div>
              <span data-testid="scanner-digit-recurrence" className="font-mono-ui text-[8px] text-[#8e9db5]">
                {displayedPrediction
                  ? `${displayedPrediction.signalLabel}: ${displayedPrediction.recentOccurrences}/${displayedPrediction.recentSampleSize} scan wins · ${displayedPrediction.analyzedWindowOccurrences}/${displayedPrediction.analyzedTickCount} scan ticks analyzed`
                  : contractType === 'over' || contractType === 'under'
                    ? `${RECENT_ANALYSIS_TICKS} ticks analyzed · fixed ${contractType === 'over' ? 'Over 3' : 'Under 6'} barrier`
                    : contractType === 'even-odd'
                      ? `${RECENT_ANALYSIS_TICKS} ticks analyzed · parity chosen from latest ${RECENT_DIGIT_WINDOW}`
                      : `${RECENT_ANALYSIS_TICKS} ticks analyzed · ${contractType === 'differ' ? 'recurring barrier' : 'most recurring digit'} from latest ${RECENT_DIGIT_WINDOW}`}
              </span>
            </div>

            {displayedPrediction ? (
              <>
                <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-[#236b8b] bg-[#0a1e2d] px-3 py-2">
                  <span className="font-mono-ui text-[8px] font-bold tracking-wider text-[#8ccbed]">WALK-FORWARD HIT RATE</span>
                  <strong data-testid="scanner-walk-forward-hit-rate" className="font-mono-ui text-[10px] font-extrabold text-[#dce8f4]">
                    {formatPercent(displayedPrediction.backtestAccuracy)} · {displayedPrediction.backtestHits}/{displayedPrediction.backtestPredictions}
                  </strong>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2.5">
                  <div className="rounded-[13px] border border-[#12d1ac] bg-gradient-to-br from-[#075d5c] to-[#07987f] p-2.5 text-center shadow-[0_0_18px_rgba(0,225,182,.27)] sm:p-3">
                    <div className="mx-auto mb-1 w-fit rounded-md bg-[#063c42]/80 px-2 py-1 font-mono-ui text-[8px] font-bold tracking-wider text-[#9df6e3]">{contractLabel}</div>
                    <strong data-testid="scanner-candidate-digit" className="block break-words font-display text-[38px] font-extrabold leading-none text-white drop-shadow-[0_2px_8px_rgba(0,0,0,.3)] sm:text-[48px]">{displayedPrediction.signalLabel}</strong>
                    <div className="mt-2 rounded-md bg-[#d7f0ff] px-2 py-1 font-mono-ui text-[8px] font-extrabold tracking-wider text-[#183351]">SCANNED CONTRACT SIGNAL</div>
                  </div>
                  <div className={`rounded-[13px] border p-2.5 text-center shadow-[0_0_18px_rgba(41,99,255,.25)] sm:p-3 ${predictionSecondsRemaining <= 2 ? 'border-[#ec5676] bg-gradient-to-br from-[#60183a] to-[#c12655]' : 'border-[#3c78ff] bg-gradient-to-br from-[#102b83] to-[#124be1]'}`}>
                    <div className="mx-auto mb-1 flex w-fit items-center gap-1 rounded-md bg-[#071b5e]/75 px-2 py-1 font-mono-ui text-[8px] font-bold tracking-wider text-[#c2d6ff]"><Clock3 size={10} /> COUNTDOWN</div>
                    <strong data-testid="scanner-prediction-timer" aria-live="polite" className="block font-display text-[36px] font-extrabold leading-[1.2] text-white sm:text-[42px]">{predictionSecondsRemaining}s</strong>
                    <div className="mt-2 rounded-md bg-[#d7f0ff] px-2 py-1 font-mono-ui text-[8px] font-extrabold tracking-wider text-[#183351]">PICK VALIDITY</div>
                  </div>
                </div>
              </>
            ) : (
              <div data-testid="scanner-warmup" className="mt-3 rounded-lg border border-[#293a46] bg-[#0c171e] px-4 py-7 text-center">
                {isAnalyzing ? (
                  <>
                    <p className="font-mono-ui text-[10px] font-bold tracking-[.16em] text-[#67d9c2]">LIVE ANALYSIS IN PROGRESS</p>
                    <strong
                      data-testid="scanner-analysis-countdown-large"
                      role="timer"
                      aria-live="polite"
                      aria-label={`${scanCountdownSeconds} seconds remaining`}
                      className="my-3 flex items-center justify-center gap-2"
                    >
                      {formatCountdown(scanCountdownSeconds).split('').map((character, index) => (
                        character === ':' ? (
                          <span key={`separator-${index}`} aria-hidden="true" className="font-display text-[46px] font-extrabold leading-none text-[#ffd347] drop-shadow-[0_0_16px_rgba(255,195,32,.45)] sm:text-[58px]">:</span>
                        ) : (
                          <span
                            key={`${index}-${character}`}
                            aria-hidden="true"
                            className="scanner-countdown-tile grid h-[62px] w-[56px] place-items-center rounded-[13px] border border-[#ffe77c] bg-gradient-to-br from-[#ffe45b] via-[#ffc914] to-[#f2a900] font-display text-[48px] font-extrabold leading-none text-[#101522] shadow-[0_0_24px_rgba(255,193,7,.28),inset_0_2px_0_rgba(255,255,255,.55),inset_0_-4px_0_rgba(150,91,0,.2)] sm:h-[76px] sm:w-[68px] sm:text-[58px]"
                          >
                            {character}
                          </span>
                        )
                      ))}
                    </strong>
                    <p className="font-mono-ui text-[9px] font-bold tracking-wider text-[#dce6ef]">SECONDS REMAINING</p>
                    <p className="mt-2 text-[9px] text-[#82939a]">
                      Collecting fresh ticks from all {totalMarkets} markets at once · each result uses ticks received during this scan.
                    </p>
                    <div className="mx-auto mt-3 h-1.5 max-w-sm overflow-hidden rounded-full bg-[#1a2636]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#26c4a4] to-[#e2bd5c] transition-[width] duration-300"
                        style={{ width: `${((SCANNER_COUNTDOWN_SECONDS - scanCountdownSeconds) / SCANNER_COUNTDOWN_SECONDS) * 100}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <Activity size={20} className="mx-auto mb-2 text-[#56d5cb]" />
                    <p className="text-[11px] font-bold text-[#dce6ef]">{scanMessage ? 'No qualified market found' : 'No market picked yet'}</p>
                    <p className="mt-1 text-[9px] text-[#82939a]">
                      {scanMessage ?? `${readyMarkets}/${totalMarkets} markets ready. Press SCAN NOW to begin.`}
                    </p>
                  </>
                )}
              </div>
            )}

            <div className="mt-3">
              <h3 className="mb-2 font-mono-ui text-[9px] font-extrabold tracking-[.13em] text-[#58c6ef]">SCANNER STATUS</h3>
              <div className="space-y-1.5 rounded-lg border border-[#263958] bg-[#080f1c] p-2.5">
                <div className="flex items-center gap-2 text-[9px]">
                  <span className={`h-1.5 w-1.5 rounded-full ${feedStatus === 'live' ? 'bg-[#28d79a]' : 'bg-[#e0bd54]'}`} />
                  <Wifi size={12} className="text-[#55c7e7]" />
                  <span className="text-[#a8bed2]">DERIV WEBSOCKET</span>
                  <strong className={`ml-auto font-mono-ui text-[8px] ${feedStatus === 'live' ? 'text-[#53dfad]' : 'text-[#e0c365]'}`}>{feedStatusLabel}</strong>
                </div>
                <div className="flex items-center gap-2 text-[9px]">
                  <span className={`h-1.5 w-1.5 rounded-full ${readyMarkets > 0 ? 'bg-[#28d79a]' : 'bg-[#e0bd54]'}`} />
                  <Signal size={12} className="text-[#55c7e7]" />
                  <span className="text-[#a8bed2]">MARKETS WITH TEST HISTORY</span>
                  <strong className="ml-auto font-mono-ui text-[8px] text-[#7fc9ed]">{readyMarkets}/{totalMarkets}</strong>
                </div>
                <div className="flex items-center gap-2 text-[9px]">
                  <span className={`h-1.5 w-1.5 rounded-full ${edgeValidated ? 'bg-[#28d79a]' : 'bg-[#e0bd54]'}`} />
                  <ShieldCheck size={12} className="text-[#55c7e7]" />
                  <span className="text-[#a8bed2]">TOP PICK WALK-FORWARD TEST</span>
                  <strong className={`ml-auto font-mono-ui text-[8px] ${edgeValidated ? 'text-[#53dfad]' : 'text-[#e0c365]'}`}>
                    {displayedPrediction
                      ? `${displayedPrediction.backtestHits}/${displayedPrediction.backtestPredictions} · ${formatPercent(displayedPrediction.backtestAccuracy)}`
                      : '--'}
                  </strong>
                </div>
              </div>
              <p data-testid="scanner-signal-status" className={`mt-2 text-[9px] font-bold ${edgeValidated ? 'text-[#72d7aa]' : 'text-[#d7b966]'}`}>
                {displayedPrediction
                  ? edgeValidated
                    ? 'Edge confirmed by walk-forward test.'
                    : 'Edge not confirmed.'
                  : 'Run a scan to select a market.'}
              </p>
            </div>
          </section>

          <section className="rounded-lg border border-[#27344d] bg-[#0a111d] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="font-mono-ui text-[9px] font-bold tracking-[.1em] text-[#9fb1c8]">MARKET + CONTRACT RANKING</h2>
              <span className="font-mono-ui text-[7px] text-[#71839d]">TOP {contractLabel} · WALK-FORWARD TEST</span>
            </div>
            {topResult ? (
              <ol data-testid="scanner-market-ranking" className="space-y-1.5">
                <li data-testid={`scanner-market-rank-${topResult.symbol}-${topResult.signalKey}`} className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-[#168b70] bg-[#073027] px-2 py-2">
                    <span className="font-mono-ui text-[8px] font-bold text-[#8295b0]">#1</span>
                    <div className="min-w-0">
                      <p className="truncate text-[9px] font-bold text-[#dce8f4]">{topResult.label}</p>
                      <p className="font-mono-ui text-[7px] text-[#7189a3]">
                        {topResult.symbol} · {topResult.backtestHits}/{topResult.backtestPredictions} tested · recent {topResult.recentOccurrences}/{topResult.recentSampleSize}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-[#215b82] bg-[#0d2740] px-1.5 py-1 font-mono-ui text-[8px] font-bold text-[#83ceff]">{topResult.signalLabel}</span>
                      <strong className="min-w-[48px] text-right font-mono-ui text-[9px] font-bold text-[#dce8f4]">{formatPercent(topResult.backtestAccuracy)}</strong>
                      <button type="button" onClick={() => onMarketSelect(topResult.symbol)} data-testid={`scanner-use-market-${topResult.symbol}-${topResult.signalKey}`} className="rounded border border-[#31516d] px-1.5 py-1 font-mono-ui text-[7px] font-bold text-[#8ccbed] transition hover:border-[#54d8d6] hover:text-white">USE</button>
                    </div>
                </li>
              </ol>
            ) : (
              <p className="rounded-md border border-[#27344d] bg-[#0c1421] px-3 py-5 text-center text-[9px] text-[#82939a]">
                {scanResults
                  ? 'No qualified market found.'
                  : 'Press SCAN NOW to scan markets.'}
              </p>
            )}
          </section>

          <div className="grid grid-cols-2 gap-2">
            <section className="rounded-lg border border-[#27344d] bg-[#0a111d] p-3">
              <h2 className="mb-2 font-mono-ui text-[8px] font-bold tracking-[.1em] text-[#9fb1c8]">LAST 20 ANALYZED TICKS</h2>
              {topTicks.length > 0 ? (
                <ol data-testid="scanner-recent-digits" aria-label="Last 20 analyzed ticks for the selected market" className="flex flex-wrap gap-1">
                  {topTicks.slice(-20).reverse().map((tick, index) => (
                    <li key={`${topTicks.length - index}-${tick.price}`} className={`grid h-6 w-6 place-items-center rounded border font-mono-ui text-[9px] font-bold ${index === 0 ? 'border-[#1d9a83] bg-[#0d4439] text-[#6de4dc]' : 'border-[#293a46] bg-[#0c171e] text-[#b8c8ce]'}`}>{tick.digit}</li>
                  ))}
                </ol>
              ) : <p className="text-[9px] text-[#82939a]">Waiting for ticks.</p>}
            </section>
            <section className="rounded-lg border border-[#27344d] bg-[#0a111d] p-3">
              <h2 className="mb-2 font-mono-ui text-[8px] font-bold tracking-[.1em] text-[#9fb1c8]">TOP PICK TEST</h2>
              <p data-testid="scanner-backtest-sample" className="font-mono-ui text-[9px] text-[#b8c8ce]">
                {topResult ? `${topResult.backtestHits}/${topResult.backtestPredictions} · ${formatPercent(topResult.backtestAccuracy)}` : 'Run a scan to compare performance'}
              </p>
              <p className="mt-1 font-mono-ui text-[7px] text-[#71839d]">Top market · sequential holdout calls</p>
            </section>
          </div>

        </div>
      </section>
    </section>
  );
}
