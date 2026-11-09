import { useEffect, useState } from 'react';
import { DigitScannerView } from './DigitScannerView';
import {
  SCANNER_PRIOR_TICK_COUNT,
  type ContractType,
  type ScannedMarket,
} from '@/lib/analysis-engine';
import {
  DEFAULT_ANALYSIS_ENGINE_CONFIGURATIONS,
  type AnalysisEngineConfiguration,
  type AnalysisEngineId,
} from '@/lib/contract-engines';
import type { PredictionOutcomeStart } from '@/lib/performance';

type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'error';
type ScannerSoundAlert = 'signal-found' | 'timer-ended';

type ScannerSettings = {
  contractType: ContractType;
  configuration: AnalysisEngineConfiguration;
};

type MarketScannerDashboardProps = {
  markets: ScannedMarket[];
  feedStatus: FeedStatus;
  feedError: string | null;
  onMarketSelect: (symbol: string) => void;
  onPredictionStart: (prediction: PredictionOutcomeStart) => void;
  onSoundAlert: (alert: ScannerSoundAlert) => void;
};

const SCANNER_SETTINGS_KEY = 'deriv-analysis-scanner-settings-v2';
const SCANNER_SETTINGS_VERSION = 2;
const LEGACY_SIGNAL_WINDOWS = [50, 100, 200, 500];

function getEngineId(contractType: ContractType): AnalysisEngineId {
  if (contractType === 'match-digit' || contractType === 'differ') return 'matches-differs';
  if (contractType === 'over' || contractType === 'under') return 'over-under';
  return 'even-odd';
}

function getDefaults(contractType: ContractType = 'match-digit'): ScannerSettings {
  const engineId = getEngineId(contractType);
  return {
    contractType,
    configuration: {
      ...DEFAULT_ANALYSIS_ENGINE_CONFIGURATIONS[engineId],
      signalWindow: SCANNER_PRIOR_TICK_COUNT,
    },
  };
}

function readScannerSettings(): ScannerSettings {
  const defaults = getDefaults();
  if (typeof window === 'undefined') return defaults;

  try {
    const stored = localStorage.getItem(SCANNER_SETTINGS_KEY);
    if (!stored) return defaults;
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return defaults;
    const saved = parsed as Record<string, unknown>;
    if (saved.version !== SCANNER_SETTINGS_VERSION) return defaults;
    const contractType = saved.contractType;
    if (contractType !== 'match-digit' && contractType !== 'differ'
      && contractType !== 'over' && contractType !== 'under'
      && contractType !== 'even-odd') {
      console.warn('Discarding invalid saved scanner contract and using defaults.');
      return defaults;
    }

    const engineId = getEngineId(contractType);
    const candidate = saved.configuration;
    if (!candidate || typeof candidate !== 'object') {
      console.warn('Discarding invalid saved scanner configuration and using defaults.');
      return getDefaults(contractType);
    }
    const configuration = candidate as Record<string, unknown>;
    const signalWindow = configuration.signalWindow;
    const targetDigit = configuration.targetDigit;
    const barrier = configuration.barrier;
    const parity = configuration.parity;
    if (!LEGACY_SIGNAL_WINDOWS.includes(Number(signalWindow))
      || !(targetDigit === null || (Number.isInteger(targetDigit)
        && Number(targetDigit) >= 0 && Number(targetDigit) <= 9))
      || !Number.isInteger(barrier)
      || Number(barrier) < 0
      || Number(barrier) > 9
      || (parity !== 'auto' && parity !== 'even' && parity !== 'odd')) {
      console.warn('Discarding invalid saved scanner configuration and using defaults.');
      return getDefaults(contractType);
    }

    return {
      contractType,
      configuration: {
        signalWindow: SCANNER_PRIOR_TICK_COUNT,
        targetDigit: targetDigit === null ? null : Number(targetDigit),
        barrier: Number(barrier),
        parity,
      },
    };
  } catch (error) {
    console.error('Unable to load scanner settings.', error);
    return defaults;
  }
}

export function MarketScannerDashboard({
  markets,
  feedStatus,
  feedError,
  onMarketSelect,
  onPredictionStart,
  onSoundAlert,
}: MarketScannerDashboardProps) {
  const [settings, setSettings] = useState(readScannerSettings);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(
        SCANNER_SETTINGS_KEY,
        JSON.stringify({ ...settings, version: SCANNER_SETTINGS_VERSION }),
      );
      setSettingsError(null);
    } catch (error) {
      console.error('Unable to save scanner settings.', error);
      setSettingsError('Scanner settings could not be saved in this browser.');
    }
  }, [settings]);

  const engineId = getEngineId(settings.contractType);
  const updateConfiguration = (configuration: Partial<AnalysisEngineConfiguration>) => {
    setSettings((current) => ({
      ...current,
      configuration: { ...current.configuration, ...configuration },
    }));
  };

  const changeContract = (contractType: ContractType) => {
    setSettings({
      contractType,
      configuration: {
        ...DEFAULT_ANALYSIS_ENGINE_CONFIGURATIONS[getEngineId(contractType)],
        signalWindow: SCANNER_PRIOR_TICK_COUNT,
      },
    });
  };

  return (
    <section
      data-testid="scanner-dashboard"
      aria-label="Market scanner"
      className="space-y-3 rounded-xl border border-[#285264] bg-[#091722] p-3 sm:p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-sm font-extrabold tracking-[.08em] text-[#e7f2f6]">CROSS-MARKET SCANNER</h2>
        </div>
        <label className="flex items-center gap-2 font-mono-ui text-[8px] font-bold text-[#82dce5]">
          SCAN TYPE
          <select
            value={settings.contractType}
            onChange={(event) => {
              const contractType = event.currentTarget.value;
              if (contractType === 'match-digit' || contractType === 'differ'
                || contractType === 'over' || contractType === 'under'
                || contractType === 'even-odd') {
                changeContract(contractType);
              }
            }}
            data-testid="select-scanner-contract"
            className="rounded border border-[#285264] bg-[#0b202c] px-2 py-1.5 text-[10px] text-[#e1f3f5]"
          >
            <option value="match-digit">MATCHES</option>
            <option value="differ">DIFFERS</option>
            <option value="over">OVER</option>
            <option value="under">UNDER</option>
            <option value="even-odd">EVEN / ODD</option>
          </select>
        </label>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="scanner-history-window" className="rounded border border-[#285264] bg-[#0b202c] px-2 py-1 font-mono-ui text-[8px] font-bold text-[#8fa4b2]">
          HISTORY · {SCANNER_PRIOR_TICK_COUNT} TICKS
        </span>

        {engineId === 'matches-differs' && (
          <label className="flex items-center gap-1.5 font-mono-ui text-[8px] text-[#8fa4b2]">
            TARGET DIGIT
            <select
              value={settings.configuration.targetDigit ?? 'auto'}
              onChange={(event) => updateConfiguration({
                targetDigit: event.currentTarget.value === 'auto' ? null : Number(event.currentTarget.value),
              })}
              data-testid="select-scanner-target"
              className="rounded border border-[#285264] bg-[#0b202c] px-2 py-1 text-[9px] text-[#e1f3f5]"
            >
              <option value="auto">AUTO · MOST FREQUENT</option>
              {Array.from({ length: 10 }, (_, digit) => <option key={digit} value={digit}>{digit}</option>)}
            </select>
          </label>
        )}

        {engineId === 'over-under' && (
          <label className="flex items-center gap-1.5 font-mono-ui text-[8px] text-[#8fa4b2]">
            BARRIER
            <select
              value={settings.configuration.barrier}
              onChange={(event) => updateConfiguration({ barrier: Number(event.currentTarget.value) })}
              data-testid="select-scanner-barrier"
              className="rounded border border-[#285264] bg-[#0b202c] px-2 py-1 text-[9px] text-[#e1f3f5]"
            >
              {Array.from({ length: 10 }, (_, digit) => <option key={digit} value={digit}>{digit}</option>)}
            </select>
          </label>
        )}

        {engineId === 'even-odd' && (
          <label className="flex items-center gap-1.5 font-mono-ui text-[8px] text-[#8fa4b2]">
            PARITY
            <select
              value={settings.configuration.parity}
              onChange={(event) => {
                const parity = event.currentTarget.value;
                if (parity === 'auto' || parity === 'even' || parity === 'odd') {
                  updateConfiguration({ parity });
                }
              }}
              data-testid="select-scanner-parity"
              className="rounded border border-[#285264] bg-[#0b202c] px-2 py-1 text-[9px] text-[#e1f3f5]"
            >
              <option value="auto">AUTO</option>
              <option value="even">EVEN</option>
              <option value="odd">ODD</option>
            </select>
          </label>
        )}
      </div>

      {settingsError && <p role="alert" className="text-[9px] text-[#ffaaaa]">{settingsError}</p>}

      <DigitScannerView
        markets={markets}
        contractType={settings.contractType}
        configuration={settings.configuration}
        feedStatus={feedStatus}
        feedError={feedError}
        onMarketSelect={onMarketSelect}
        onPredictionStart={onPredictionStart}
        onSoundAlert={onSoundAlert}
      />
    </section>
  );
}
