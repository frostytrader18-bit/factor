import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Clock3, ShieldCheck, Signal, Target, Wifi } from 'lucide-react';
import {
  FRESH_SCAN_TICK_COUNT,
  MATCH_EXECUTION_DELAY_TICKS,
  SCANNER_PRIOR_TICK_COUNT,
  isContractWin,
  scanMarkets,
  type ContractSignal,
  type ContractType,
  type LiveTick,
  type MarketCandidate,
  type ScannedMarket,
} from '@/lib/analysis-engine';
import type { AnalysisEngineConfiguration } from '@/lib/contract-engines';
import type { PredictionOutcomeStart } from '@/lib/performance';
import { shouldScheduleAutomaticScan } from '@/lib/scanner-scheduling';

type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'error';
type ScannerSoundAlert = 'signal-found' | 'timer-ended';
export type { ContractType } from '@/lib/analysis-engine';
export type { PredictionOutcomeStart } from '@/lib/performance';
export { isContractWin };

type ActivePrediction = ContractSignal & {
  contractType: ContractType;
  marketSymbol: string;
  marketLabel: string;
  analyzedTicks: LiveTick[];
  freshTickCount: number;
  backtestHits: number;
  backtestPredictions: number;
  backtestAccuracy: number;
  wilsonLowerBound: number;
  wilsonUpperBound: number;
  isValidated: boolean;
  expiresAt: number;
};

type DigitScannerViewProps = {
  markets: ScannedMarket[];
  contractType: ContractType;
  autoScan: boolean;
  tradingArmed: boolean;
  tradingBusy: boolean;
  tradingScanRequestId: number;
  feedStatus: FeedStatus;
  feedError: string | null;
  configuration: AnalysisEngineConfiguration;
  onMarketSelect: (symbol: string) => void;
  onPredictionStart: (prediction: PredictionOutcomeStart) => void;
  onSoundAlert: (alert: ScannerSoundAlert) => void;
};

const TICK_COLLECTION_SECONDS = 10;
const SCANNER_COUNTDOWN_SECONDS = TICK_COLLECTION_SECONDS;
const PREDICTION_VALIDITY_SECONDS = 30;
const AUTO_SCAN_INITIAL_DELAY_MS = 1000;
const AUTO_SCAN_RETRY_DELAY_MS = 5000;

function formatPercent(value: number | null) {
  return value === null ? '--' : `${(value * 100).toFixed(1)}%`;
}

function formatCountdown(seconds: number) {
  return seconds.toString().padStart(2, '0');
}

function settingsDigitLabel(contractType: ContractType, targetDigit: number | null) {
  const target = targetDigit === null
    ? contractType === 'match-digit'
      ? 'the next digit estimated from recent digit transitions'
      : 'the most frequent digit in the analysis window'
    : `configured digit ${targetDigit}`;
  return contractType === 'differ' ? `DIFFERS from ${target}` : `target ${target}`;
}

export function DigitScannerView({
  markets,
  contractType,
  autoScan,
  tradingArmed,
  tradingBusy,
  tradingScanRequestId,
  feedStatus,
  feedError,
  configuration,
  onMarketSelect,
  onPredictionStart,
  onSoundAlert,
}: DigitScannerViewProps) {
  const [predictionSecondsRemaining, setPredictionSecondsRemaining] = useState(0);
  const [scanCountdownSeconds, setScanCountdownSeconds] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isAutomaticScan, setIsAutomaticScan] = useState(false);
  const [scanPhase, setScanPhase] = useState<'idle' | 'collecting' | 'deciding'>('idle');
  const [activePrediction, setActivePrediction] = useState<ActivePrediction | null>(null);
  const [lastManualScan, setLastManualScan] = useState<string | null>(null);
  const [scanResults, setScanResults] = useState<MarketCandidate[] | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const marketsRef = useRef(markets);
  const scanStartTickVersionsRef = useRef(new Map<string, number>());
  const processedTradingScanRequestRef = useRef(0);
  const callbacksRef = useRef({ onMarketSelect, onPredictionStart, onSoundAlert });
  marketsRef.current = markets;
  callbacksRef.current = { onMarketSelect, onPredictionStart, onSoundAlert };
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
  const readyMarkets = markets.filter((market) => (
    market.ticks.length >= SCANNER_PRIOR_TICK_COUNT
  )).length;
  const rankedMarkets = scanResults ?? [];
  const topResult = rankedMarkets[0] ?? null;
  const predictionIsActive = feedStatus === 'live' && predictionSecondsRemaining > 0;
  const displayedPrediction = predictionIsActive ? activePrediction : null;
  const edgeValidated = displayedPrediction !== null
    && displayedPrediction.isValidated;

  useEffect(() => {
    setActivePrediction(null);
    setPredictionSecondsRemaining(0);
    setScanResults(null);
    setScanMessage(null);
    if (isAnalyzing) {
      setIsAnalyzing(false);
      setScanCountdownSeconds(0);
    }
    setScanPhase('idle');
  }, [configuration, contractType]);

  const initiateManualScan = useCallback((automatic = false) => {
    if (feedStatus !== 'live' || isAnalyzing) {
      return;
    }

    setIsAutomaticScan(automatic);
    setActivePrediction(null);
    setPredictionSecondsRemaining(0);
    setScanResults(null);
    scanStartTickVersionsRef.current = new Map(
      marketsRef.current.map((market) => [market.symbol, market.tickVersion]),
    );
    setScanMessage('Collecting 10 fresh ticks for 10s; the best available prediction will be submitted as soon as the scan completes while trading is running.');
    setScanPhase('collecting');
    setScanCountdownSeconds(SCANNER_COUNTDOWN_SECONDS);
    setIsAnalyzing(true);
  }, [feedStatus, isAnalyzing]);

  useEffect(() => {
    if (
      tradingScanRequestId === 0
      || tradingScanRequestId <= processedTradingScanRequestRef.current
    ) {
      return;
    }
    if (!tradingArmed) {
      processedTradingScanRequestRef.current = tradingScanRequestId;
      return;
    }
    if (
      feedStatus !== 'live'
      || readyMarkets === 0
      || isAnalyzing
    ) {
      return;
    }

    processedTradingScanRequestRef.current = tradingScanRequestId;
    initiateManualScan(true);
  }, [
    feedStatus,
    initiateManualScan,
    isAnalyzing,
    readyMarkets,
    tradingArmed,
    tradingScanRequestId,
  ]);

  useEffect(() => {
    if (autoScan || !isAnalyzing || !isAutomaticScan) {
      return;
    }

    setIsAnalyzing(false);
    setIsAutomaticScan(false);
    setScanPhase('idle');
    setScanCountdownSeconds(0);
    setScanMessage('Automatic scan stopped.');
  }, [autoScan, isAnalyzing, isAutomaticScan]);

  useEffect(() => {
    if (!shouldScheduleAutomaticScan({
      autoScan,
      feedLive: feedStatus === 'live',
      readyMarkets,
      isAnalyzing,
      tradingArmed,
      tradingBusy,
      predictionActive: predictionIsActive,
    })) {
      return;
    }

    const delay = tradingArmed
      ? AUTO_SCAN_INITIAL_DELAY_MS
      : scanResults === null
        ? AUTO_SCAN_INITIAL_DELAY_MS
        : AUTO_SCAN_RETRY_DELAY_MS;
    const timer = window.setTimeout(() => initiateManualScan(true), delay);
    return () => window.clearTimeout(timer);
  }, [
    autoScan,
    feedStatus,
    initiateManualScan,
    isAnalyzing,
    predictionIsActive,
    readyMarkets,
    scanResults,
    tradingArmed,
    tradingBusy,
  ]);

  useEffect(() => {
    if (!isAnalyzing) {
      return;
    }

    if (feedStatus !== 'live') {
      setIsAnalyzing(false);
      setScanPhase('idle');
      setScanCountdownSeconds(0);
      setScanMessage('Scan canceled because the live feed disconnected. Reconnect and scan again.');
      return;
    }

    const scanStartedAt = Date.now();
    const collectionDeadline = scanStartedAt + TICK_COLLECTION_SECONDS * 1000;
    let decisionStarted = false;

    const finishScan = (results: MarketCandidate[], scannedMarketCount: number) => {
      setIsAnalyzing(false);
      setScanPhase('idle');
      setScanCountdownSeconds(0);
      setLastManualScan(new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }));
      if (results.length === 0) {
        setActivePrediction(null);
        setPredictionSecondsRemaining(0);
        setScanResults([]);
        setScanMessage(
          `No usable tick history was available for a prediction. Markets with fresh ticks: ${scannedMarketCount}/${marketsRef.current.length}.`,
        );
        return;
      }

      const topCandidate = results[0];
      setScanResults(results);
      setScanMessage(
        `Prediction: ${topCandidate.signalLabel} · ${topCandidate.label} · ${topCandidate.isValidated ? 'validated' : 'unconfirmed'}${contractType === 'match-digit' ? ` · target is ${MATCH_EXECUTION_DELAY_TICKS} ticks after entry` : ''} · ${topCandidate.freshTickCount}/${FRESH_SCAN_TICK_COUNT} fresh ticks · ${scannedMarketCount}/${marketsRef.current.length} markets had new ticks.`,
      );
      callbacksRef.current.onSoundAlert('signal-found');
      const startedAt = Date.now();
      const expiresAt = startedAt + PREDICTION_VALIDITY_SECONDS * 1000;
      const outcomeStart: PredictionOutcomeStart = {
        id: `${topCandidate.engineId}-${topCandidate.symbol}-${startedAt}`,
        engineId: topCandidate.engineId,
        contractType,
        signalKey: topCandidate.signalKey,
        signalLabel: topCandidate.signalLabel,
        digit: topCandidate.digit,
        marketSymbol: topCandidate.symbol,
        marketLabel: topCandidate.label,
        startedAt,
        expiresAt,
        targetTickOffset: contractType === 'match-digit'
          ? MATCH_EXECUTION_DELAY_TICKS
          : 0,
        baselineRate: topCandidate.baselineRate,
        backtestHits: topCandidate.backtestHits,
        backtestPredictions: topCandidate.backtestPredictions,
        backtestAccuracy: topCandidate.backtestAccuracy,
        estimatedProbability: topCandidate.estimatedProbability,
        wilsonLowerBound: topCandidate.wilsonLowerBound,
        wilsonUpperBound: topCandidate.wilsonUpperBound,
        expectedValue: topCandidate.expectedValue,
        isValidated: topCandidate.isValidated,
      };
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
        analyzedTicks: topCandidate.analyzedTicks,
        freshTickCount: topCandidate.freshTickCount,
        marketSymbol: topCandidate.symbol,
        marketLabel: topCandidate.label,
        backtestHits: topCandidate.backtestHits,
        backtestPredictions: topCandidate.backtestPredictions,
        backtestAccuracy: topCandidate.backtestAccuracy,
        wilsonLowerBound: topCandidate.wilsonLowerBound,
        wilsonUpperBound: topCandidate.wilsonUpperBound,
        isValidated: topCandidate.isValidated,
        expiresAt,
      });
      setPredictionSecondsRemaining(PREDICTION_VALIDITY_SECONDS);
      callbacksRef.current.onMarketSelect(topCandidate.symbol);
    };

    const startDecisionPhase = () => {
      if (decisionStarted) return;
      decisionStarted = true;
      setScanPhase('deciding');
      setScanCountdownSeconds(0);
      setScanMessage(
        `Analyzing the prior ${SCANNER_PRIOR_TICK_COUNT} ticks plus whatever fresh ticks arrived.`,
      );

      const scanTicksByMarket = new Map<string, LiveTick[]>();
      for (const market of marketsRef.current) {
        const freshTickCount = market.tickVersion
          - (scanStartTickVersionsRef.current.get(market.symbol) ?? market.tickVersion);
        if (freshTickCount > 0
          && freshTickCount <= market.ticks.length) {
          scanTicksByMarket.set(market.symbol, market.ticks.slice(-freshTickCount));
        }
      }

      let finalResults: MarketCandidate[];
      try {
        finalResults = scanMarkets(
          marketsRef.current,
          contractType,
          scanTicksByMarket,
          configuration,
        );
      } catch (error) {
        console.error(`The ${contractLabel} analysis engine failed during a scan.`, error);
        setIsAnalyzing(false);
        setScanPhase('idle');
        setScanCountdownSeconds(0);
        setActivePrediction(null);
        setPredictionSecondsRemaining(0);
        setScanResults([]);
        setScanMessage(
          `DATA ERROR: the ${contractLabel} engine could not validate the current configuration or market data. Check the settings and retry.`,
        );
        return;
      }

      const scannedMarketCount = scanTicksByMarket.size;
      finishScan(finalResults, scannedMarketCount);
    };

    const collectionTimer = window.setInterval(() => {
      const now = Date.now();
      setScanCountdownSeconds(Math.max(
        0,
        Math.ceil((collectionDeadline - now) / 1000),
      ));
      if (now >= collectionDeadline) {
        window.clearInterval(collectionTimer);
        startDecisionPhase();
      }
    }, 100);

    return () => {
      window.clearInterval(collectionTimer);
    };
  }, [contractType, configuration, feedStatus, isAnalyzing]);

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
        callbacksRef.current.onSoundAlert('timer-ended');
        setActivePrediction(null);
      }
    };

    updateTimer();
    const timer = window.setInterval(updateTimer, 250);
    return () => window.clearInterval(timer);
  }, [activePrediction, feedStatus]);

  const topTicks = displayedPrediction?.analyzedTicks ?? topResult?.analyzedTicks ?? [];
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
                <p className="truncate text-[10px] font-extrabold text-[#dff8f5]">{totalMarkets} markets · {readyMarkets} ready</p>
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
                onClick={() => initiateManualScan()}
                disabled={!canScan}
                data-testid="scanner-scan-now"
                className="flex items-center gap-1.5 rounded-md border border-[#c4a44e] bg-gradient-to-r from-[#b68a31] to-[#e0bc5c] px-3 py-1.5 font-mono-ui text-[9px] font-extrabold tracking-wider text-[#211b10] shadow-[0_3px_15px_rgba(195,155,58,.14)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Target size={12} />
                {isAnalyzing
                  ? scanPhase === 'collecting' ? 'COLLECTING…' : 'DECIDING…'
                  : 'SCAN NOW'}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono-ui text-[9px] text-[#98a9c2]">
                {isAnalyzing
                  ? scanPhase === 'collecting'
                    ? `COLLECTING 10 FRESH TICKS · ${totalMarkets} MARKETS`
                    : `DECIDING FROM 100 PRIOR + 10 FRESH TICKS`
                  : displayedPrediction
                    ? `TOP ${contractLabel} PERFORMER · ${displayedPrediction.marketSymbol}`
                    : scanResults
                      ? 'SCAN COMPLETE · RUN AGAIN FOR A FRESH RESULT'
                      : 'READY'}
              </span>
              <span className="rounded-md border border-[#214c98] bg-[#102653] px-2.5 py-1 font-mono-ui text-[9px] font-bold text-[#70baff]">
                {isAnalyzing
                  ? scanPhase === 'collecting' ? '10s COLLECTION' : 'ANALYZING'
                  : displayedPrediction
                    ? `PICK EXPIRES IN ${predictionSecondsRemaining}s`
                    : feedStatusLabel}
              </span>
            </div>
            <p data-testid="scanner-last-manual-scan" aria-live="polite" className="mt-1 font-mono-ui text-[8px] text-[#8295b0]">
              {scanMessage
                ?? (lastManualScan
                  ? `Latest manual scan: ${lastManualScan}`
                  : 'Ready to scan.')}
            </p>
          </section>

          <section className="rounded-[13px] border border-[#176a79] bg-gradient-to-b from-[#0c1a28] to-[#07111b] p-2.5 shadow-[0_0_18px_rgba(32,201,220,.08)] sm:p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono-ui text-[8px] font-bold tracking-[.12em] text-[#e2bd5c]">{displayedPrediction ? displayedPrediction.isValidated ? 'VALIDATED WALK-FORWARD PREDICTION' : 'TOP-RANKED PREDICTION · EDGE UNCONFIRMED' : topResult ? 'TOP-RANKED WATCH CANDIDATE' : 'WALK-FORWARD PREDICTION'} · {contractLabel}</p>
                <h2 data-testid="scanner-selected-market" className="mt-1 text-[15px] font-extrabold leading-tight text-[#edf3ff] sm:text-[18px]">{(displayedPrediction?.marketLabel ?? topResult?.label)?.toUpperCase() ?? 'SCANNING MARKETS'}</h2>
                {(displayedPrediction || topResult) && <p data-testid="scanner-selected-symbol" className="mt-0.5 font-mono-ui text-[8px] font-bold text-[#72b7eb]">{displayedPrediction?.marketSymbol ?? topResult?.symbol}</p>}
              </div>
              <span data-testid="scanner-edge-badge" className={`rounded-full border px-2 py-1 font-mono-ui text-[8px] font-bold tracking-wide ${edgeValidated ? 'border-[#168a61] bg-[#073a2a] text-[#61e4aa]' : 'border-[#755f30] bg-[#302713] text-[#e0c365]'}`}>
                {edgeValidated ? 'EDGE TEST PASSED' : displayedPrediction ? 'PREDICTION · UNCONFIRMED' : topResult ? 'WATCH ONLY · EDGE UNCONFIRMED' : 'SCAN TO SELECT'}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-lg border border-[#216caf] bg-[#08284c] px-3 py-2 shadow-[0_0_15px_rgba(27,135,255,.18)]">
                <Target size={14} className="text-[#5bbaff]" />
                <div>
                  <p className="font-mono-ui text-[7px] font-bold tracking-wider text-[#70baff]">WALK-FORWARD LOWER BOUND</p>
                  <strong data-testid="scanner-candidate-probability" title="Historical lower bound, not a forecast." className="font-display text-[16px] font-extrabold text-[#e8f5ff]">
                    {displayedPrediction || topResult
                      ? formatPercent(displayedPrediction?.wilsonLowerBound ?? topResult?.wilsonLowerBound ?? null)
                      : '--'}
                  </strong>
                </div>
              </div>
              <span data-testid="scanner-digit-recurrence" className="font-mono-ui text-[8px] text-[#8e9db5]">
                {displayedPrediction
                  ? contractType === 'match-digit' && configuration.targetDigit === null
                    ? `Transition model: ${displayedPrediction.analyzedTicks.at(-1)?.digit ?? '--'} → ${displayedPrediction.signalLabel.replace('MATCH ', '')} in ${MATCH_EXECUTION_DELAY_TICKS} ticks · ${displayedPrediction.recentOccurrences}/${displayedPrediction.recentSampleSize} matching transitions · ${SCANNER_PRIOR_TICK_COUNT} prior + ${displayedPrediction.freshTickCount} fresh`
                    : `${displayedPrediction.signalLabel}: ${displayedPrediction.recentOccurrences}/${displayedPrediction.recentSampleSize} recent wins · ${SCANNER_PRIOR_TICK_COUNT} prior + ${displayedPrediction.freshTickCount} fresh`
                  : contractType === 'over' || contractType === 'under'
                    ? `${SCANNER_PRIOR_TICK_COUNT} prior + available fresh ticks · ${contractType.toUpperCase()} ${configuration.barrier} barrier`
                    : contractType === 'even-odd'
                      ? `${SCANNER_PRIOR_TICK_COUNT} prior + available fresh ticks · ${configuration.parity === 'auto' ? 'parity selected from the analysis window' : `${configuration.parity.toUpperCase()} selected`}`
                      : `${SCANNER_PRIOR_TICK_COUNT} prior + available fresh ticks · ${settingsDigitLabel(contractType, configuration.targetDigit)}${contractType === 'match-digit' ? ` · ${MATCH_EXECUTION_DELAY_TICKS}-tick execution delay` : ''}`}
              </span>
            </div>

            {displayedPrediction ? (
              <>
                <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-[#236b8b] bg-[#0a1e2d] px-3 py-2">
                  <span className="font-mono-ui text-[8px] font-bold tracking-wider text-[#8ccbed]">HISTORICAL WALK-FORWARD HIT RATE</span>
                  <strong data-testid="scanner-walk-forward-hit-rate" className="font-mono-ui text-[10px] font-extrabold text-[#dce8f4]">
                    {displayedPrediction.backtestPredictions > 0
                      ? `${formatPercent(displayedPrediction.backtestAccuracy)} · ${displayedPrediction.backtestHits}/${displayedPrediction.backtestPredictions}`
                      : 'N/A · insufficient historical samples'}
                  </strong>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2.5">
                  <div className="rounded-[13px] border border-[#12d1ac] bg-gradient-to-br from-[#075d5c] to-[#07987f] p-2.5 text-center shadow-[0_0_18px_rgba(0,225,182,.27)] sm:p-3">
                    <div className="mx-auto mb-1 w-fit rounded-md bg-[#063c42]/80 px-2 py-1 font-mono-ui text-[8px] font-bold tracking-wider text-[#9df6e3]">{contractLabel}</div>
                    <strong data-testid="scanner-candidate-digit" className="block break-words font-display text-[38px] font-extrabold leading-none text-white drop-shadow-[0_2px_8px_rgba(0,0,0,.3)] sm:text-[48px]">{displayedPrediction.signalLabel}</strong>
                    <div className="mt-2 rounded-md bg-[#d7f0ff] px-2 py-1 font-mono-ui text-[8px] font-extrabold tracking-wider text-[#183351]">{displayedPrediction.isValidated ? 'EDGE THRESHOLD PASSED' : 'CANDIDATE · NOT VALIDATED'}</div>
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
                    <p className="font-mono-ui text-[10px] font-bold tracking-[.16em] text-[#67d9c2]">
                      {scanPhase === 'collecting' ? 'COLLECTING FRESH TICKS' : 'DECIDING PREDICTION'}
                    </p>
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
                    <p className="font-mono-ui text-[9px] font-bold tracking-wider text-[#dce6ef]">
                      {scanPhase === 'collecting' ? 'SCAN TIME REMAINING' : 'ANALYZING SIGNAL'}
                    </p>
                    <p className="mt-2 text-[9px] text-[#82939a]">
                      {scanPhase === 'collecting'
                        ? `Collecting 10 fresh ticks across ${totalMarkets} markets; the signal is submitted immediately when the scan completes if trading is running.`
                        : `Using the prior 100 ticks plus fresh ticks. Validated signals are submitted immediately; low-data candidates remain unconfirmed.`}
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
                    <p className="text-[11px] font-bold text-[#dce6ef]">{topResult ? 'Best-ranked watch candidate · validation not passed' : scanMessage ? 'Insufficient comparable data' : 'No market picked yet'}</p>
                    <p className="mt-1 text-[9px] text-[#82939a]">
                      {scanMessage ?? `${readyMarkets}/${totalMarkets} markets ready.`}
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
                    {displayedPrediction || topResult
                      ? `${displayedPrediction?.backtestHits ?? topResult?.backtestHits}/${displayedPrediction?.backtestPredictions ?? topResult?.backtestPredictions} · ${formatPercent(displayedPrediction?.backtestAccuracy ?? topResult?.backtestAccuracy ?? null)}`
                      : '--'}
                  </strong>
                </div>
              </div>
              <p data-testid="scanner-signal-status" className={`mt-2 text-[9px] font-bold ${edgeValidated ? 'text-[#72d7aa]' : 'text-[#d7b966]'}`}>
                {displayedPrediction
                  ? edgeValidated
                    ? 'Validated'
                    : 'Unvalidated'
                    : scanResults
                      ? scanResults.length > 0
                        ? `${new Set(rankedMarkets.map(({ symbol }) => symbol)).size} markets analyzed`
                        : 'Insufficient data'
                      : 'Run scan'}
              </p>
            </div>
          </section>

        </div>
      </section>
    </section>
  );
}
