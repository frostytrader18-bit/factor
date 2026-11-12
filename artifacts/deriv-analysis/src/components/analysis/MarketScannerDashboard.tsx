import { useEffect, useState } from 'react';
import { AlertTriangle, Play, ShieldCheck, Square } from 'lucide-react';
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
import type { SignalTradingSettings } from '@/lib/signal-trading';

type TradingAccount = {
  accountId: string;
  accountType: 'demo' | 'real';
  balance: number;
  currency: string;
};

type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'error';
type ScannerSoundAlert = 'signal-found' | 'timer-ended';

type ScannerSettings = {
  contractType: ContractType;
  configuration: AnalysisEngineConfiguration;
};

type MarketScannerDashboardProps = {
  markets: ScannedMarket[];
  autoScan: boolean;
  tradingScanRequestId: number;
  feedStatus: FeedStatus;
  feedError: string | null;
  onMarketSelect: (symbol: string) => void;
  onPredictionStart: (prediction: PredictionOutcomeStart) => void;
  onSoundAlert: (alert: ScannerSoundAlert) => void;
  tradingSettings: SignalTradingSettings;
  selectedAccount: TradingAccount | null;
  tradingBusy: boolean;
  tradingStatus: string;
  onTradingSettingsChange: (settings: SignalTradingSettings) => void;
  onClearTradingValues: () => void;
  onToggleTrading: () => void;
  onResetTradingSession: () => void;
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
  autoScan,
  tradingScanRequestId,
  feedStatus,
  feedError,
  onMarketSelect,
  onPredictionStart,
  onSoundAlert,
  tradingSettings,
  selectedAccount,
  tradingBusy,
  tradingStatus,
  onTradingSettingsChange,
  onClearTradingValues,
  onToggleTrading,
  onResetTradingSession,
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
  const updateTradingSetting = <K extends keyof SignalTradingSettings>(
    key: K,
    value: SignalTradingSettings[K],
  ) => onTradingSettingsChange({ ...tradingSettings, [key]: value });
  const tradingNumberClass = 'w-full rounded-md border border-[#285264] bg-[#0b202c] px-2.5 py-2 text-[11px] text-[#e1f3f5] outline-none focus:border-[#3dd5e3]';

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
              <option value="auto">
                {settings.contractType === 'match-digit'
                  ? 'AUTO · TRANSITION MODEL'
                  : 'AUTO · MOST FREQUENT'}
              </option>
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

      <section
        data-testid="signal-trading-panel"
        aria-label="Signal trading controls"
        className="rounded-xl border border-[#356f70]/70 bg-[linear-gradient(145deg,rgba(13,42,45,.8),rgba(9,23,34,.95))] p-3 sm:p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[#36a995]/40 bg-[#103b36] text-[#77e6ce]">
              <ShieldCheck size={16} />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-[11px] font-extrabold tracking-[.08em] text-[#e4f2ee]">SIGNAL TRADING</h3>
              <p className="mt-1 text-[9px] leading-relaxed text-[#8fa7a7]">
                Uses the selected account · predictions trade as detected, including unconfirmed signals · one open order at a time.
              </p>
            </div>
          </div>
          <span className={`rounded-full border px-2.5 py-1 font-mono-ui text-[8px] font-extrabold tracking-wider ${
            tradingSettings.armed
              ? 'border-[#33a786]/60 bg-[#103b32] text-[#86edc4]'
              : 'border-[#49606b] bg-[#182630] text-[#a3b3bc]'
          }`}>
            {tradingSettings.armed
              ? `TRADING · ${selectedAccount?.accountType.toUpperCase() ?? 'ACCOUNT'}`
              : 'DISARMED'}
          </span>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1">
            <span className="block font-mono-ui text-[8px] font-bold tracking-wider text-[#83b6b3]">STAKE · {selectedAccount?.currency || 'ACCOUNT CURRENCY'}</span>
            <input
              type="number"
              min="0.35"
              max={selectedAccount?.balance ?? 10000}
              step="0.01"
              value={tradingSettings.stake ?? ''}
              placeholder="Enter stake"
              onChange={(event) => updateTradingSetting(
                'stake',
                event.currentTarget.value === '' ? null : Number(event.currentTarget.value),
              )}
              disabled={tradingSettings.armed || tradingBusy}
              data-testid="input-trading-stake"
              aria-label="Trade stake"
              className={tradingNumberClass}
            />
          </label>
          <label className="space-y-1">
            <span className="block font-mono-ui text-[8px] font-bold tracking-wider text-[#83b6b3]">TRADE DURATION</span>
            <input
              type="number"
              min="1"
              max="10"
              step="1"
              value={tradingSettings.durationTicks}
              onChange={(event) => updateTradingSetting('durationTicks', Number(event.currentTarget.value))}
              disabled={tradingSettings.armed || tradingBusy}
              data-testid="input-trading-duration"
              aria-label="Trade duration in ticks"
              placeholder="Enter ticks (1–10)"
              className={tradingNumberClass}
            />
            <span className="block text-[8px] leading-relaxed text-[#82979f]">
              Enter 1–10 ticks. For 2 ticks, tick 1 opens and tick 2 closes the trade.
            </span>
          </label>
          <label className="space-y-1">
            <span className="block font-mono-ui text-[8px] font-bold tracking-wider text-[#83b6b3]">TAKE PROFIT</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={tradingSettings.takeProfit ?? ''}
              placeholder="Enter limit"
              onChange={(event) => updateTradingSetting(
                'takeProfit',
                event.currentTarget.value === '' ? null : Number(event.currentTarget.value),
              )}
              disabled={tradingSettings.armed || tradingBusy}
              data-testid="input-trading-take-profit"
              aria-label="Session take profit"
              className={tradingNumberClass}
            />
          </label>
          <label className="space-y-1">
            <span className="block font-mono-ui text-[8px] font-bold tracking-wider text-[#83b6b3]">STOP LOSS</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={tradingSettings.stopLoss ?? ''}
              placeholder="Enter limit"
              onChange={(event) => updateTradingSetting(
                'stopLoss',
                event.currentTarget.value === '' ? null : Number(event.currentTarget.value),
              )}
              disabled={tradingSettings.armed || tradingBusy}
              data-testid="input-trading-stop-loss"
              aria-label="Session stop loss"
              className={tradingNumberClass}
            />
          </label>
        </div>

        <div className="mt-3 rounded-lg border border-[#273f4a] bg-[#0a1821]/80 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono-ui text-[9px] font-extrabold tracking-wider text-[#dce9e7]">MARTINGALE</p>
              <p className="mt-1 text-[9px] text-[#82979f]">
                {tradingSettings.martingaleEnabled
                  ? 'Enabled · applies the selected strategy factor to the base stake.'
                  : 'Off · every trade uses the base stake.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={tradingSettings.martingaleEnabled}
              aria-label="Martingale"
              onClick={() => updateTradingSetting('martingaleEnabled', !tradingSettings.martingaleEnabled)}
              disabled={tradingSettings.armed || tradingBusy}
              data-testid="toggle-martingale"
              className={`flex min-h-9 items-center gap-2 rounded-lg border px-3 py-2 font-mono-ui text-[9px] font-extrabold tracking-wider transition disabled:cursor-not-allowed disabled:opacity-50 ${
                tradingSettings.martingaleEnabled
                  ? 'border-[#bd8a42]/60 bg-[#3a2a19] text-[#f2cd88]'
                  : 'border-[#38505d] bg-[#14242e] text-[#a8c0c6]'
              }`}
            >
              <span className={`relative h-[14px] w-[25px] rounded-full transition ${
                tradingSettings.martingaleEnabled ? 'bg-[#c18a3d]' : 'bg-[#43505b]'
              }`}>
                <span className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-[#fff4dd] transition-transform ${
                  tradingSettings.martingaleEnabled ? 'translate-x-[13px]' : 'translate-x-[2px]'
                }`} />
              </span>
              {tradingSettings.martingaleEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <label className="space-y-1">
              <span className="block font-mono-ui text-[8px] font-bold tracking-wider text-[#83b6b3]">MARTINGALE STRATEGY</span>
              <select
                value={tradingSettings.multiplierLevel}
                onChange={(event) => {
                  const level = Number(event.currentTarget.value);
                  if (level === 1 || level === 2 || level === 3) {
                    updateTradingSetting('multiplierLevel', level);
                  }
                }}
                disabled={!tradingSettings.martingaleEnabled || tradingSettings.armed || tradingBusy}
                data-testid="select-trading-multiplier-level"
                aria-label="Martingale strategy"
                className={tradingNumberClass}
              >
                <option value="1">CLASSIC</option>
                <option value="2">DYNAMIC</option>
                <option value="3">DYNAMIC HYBRID</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="block font-mono-ui text-[8px] font-bold tracking-wider text-[#83b6b3]">
                MARTINGALE VALUE · {['CLASSIC', 'DYNAMIC', 'DYNAMIC HYBRID'][tradingSettings.multiplierLevel - 1]}
              </span>
              <input
                type="number"
                min="1"
                max="100"
                step="0.1"
                value={tradingSettings.martingaleFactor ?? ''}
                onChange={(event) => updateTradingSetting(
                  'martingaleFactor',
                  event.currentTarget.value === '' ? null : Number(event.currentTarget.value),
                )}
                disabled={!tradingSettings.martingaleEnabled || tradingSettings.armed || tradingBusy}
                data-testid="input-martingale-value"
                aria-label={`Martingale value for ${['Classic', 'Dynamic', 'Dynamic Hybrid'][tradingSettings.multiplierLevel - 1]}`}
                placeholder="Enter multiplier"
                className={tradingNumberClass}
              />
            </label>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#273f4a] bg-[#0a1821]/80 px-3 py-2">
          <div className="min-w-0">
            <p className="font-mono-ui text-[8px] font-bold tracking-wider text-[#9bb4b6]">SESSION RESULT</p>
            <p className={`mt-0.5 font-mono-ui text-[11px] font-extrabold tabular-nums ${
              tradingSettings.sessionProfit >= 0 ? 'text-[#86edc4]' : 'text-[#ffaaa0]'
            }`}>
              {tradingSettings.sessionProfit.toFixed(2)} {selectedAccount?.currency ?? ''}
              <span className="ml-1 text-[8px] font-medium text-[#82979f]">
                · TP {tradingSettings.takeProfit ?? '—'} / SL {tradingSettings.stopLoss ?? '—'}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onResetTradingSession}
            disabled={tradingSettings.armed || tradingBusy}
            data-testid="button-reset-trading-session"
            className="rounded-md border border-[#38505d] bg-[#14242e] px-2.5 py-1.5 font-mono-ui text-[8px] font-bold tracking-wider text-[#a8c0c6] transition hover:border-[#4c8990] disabled:cursor-not-allowed disabled:opacity-40"
          >
            RESET SESSION
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onClearTradingValues}
            disabled={tradingSettings.armed || tradingBusy}
            data-testid="button-clear-trading-values"
            className="flex min-h-9 items-center justify-center rounded-lg border border-[#38505d] bg-[#14242e] px-3 py-2 font-mono-ui text-[9px] font-bold tracking-wider text-[#a8c0c6] transition hover:border-[#4c8990] disabled:cursor-not-allowed disabled:opacity-40"
          >
            CLEAR VALUES
          </button>
          <button
            type="button"
            onClick={onToggleTrading}
            disabled={tradingBusy}
            aria-pressed={tradingSettings.armed}
            data-testid="toggle-signal-trading"
            className={`flex min-h-9 items-center justify-center gap-2 rounded-lg border px-3 py-2 font-mono-ui text-[9px] font-extrabold tracking-wider transition disabled:cursor-not-allowed disabled:opacity-50 ${
              tradingSettings.armed
                ? 'border-[#ac564f]/70 bg-[#412423] text-[#ffb5a7] hover:bg-[#542a27]'
                : 'border-[#1e9e83]/70 bg-[#0d3a31] text-[#8ce9c7] hover:border-[#42c5a5] hover:bg-[#10493c]'
            }`}
          >
            {tradingSettings.armed ? <Square size={12} /> : <Play size={12} />}
            {tradingSettings.armed
              ? 'STOP TRADING'
              : `START ${selectedAccount ? `${selectedAccount.accountType.toUpperCase()} ` : ''}TRADING`}
          </button>
          {selectedAccount && (
            <span className={`font-mono-ui text-[8px] font-bold tracking-wider ${
              selectedAccount.accountType === 'demo' ? 'text-[#84e4bd]' : 'text-[#f1c778]'
            }`}>
              {selectedAccount.accountType.toUpperCase()} · BALANCE {selectedAccount.balance.toFixed(2)} {selectedAccount.currency}
            </span>
          )}
        </div>
        <p
          role={tradingStatus.startsWith('ERROR') ? 'alert' : 'status'}
          aria-live="polite"
          data-testid="text-trading-status"
          className="mt-2 flex items-start gap-1.5 text-[9px] leading-relaxed text-[#9bb1b6]"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0 text-[#d9ba78]" />
          {tradingStatus || (selectedAccount
            ? `Start trading to scan now and automatically submit the next signal to the selected ${selectedAccount.accountType} account.`
            : 'Connect a Deriv account and select a real or demo account to enable signal trading.')}
        </p>
      </section>

      <DigitScannerView
        markets={markets}
        contractType={settings.contractType}
        autoScan={autoScan}
        tradingArmed={tradingSettings.armed}
        tradingScanRequestId={tradingScanRequestId}
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
