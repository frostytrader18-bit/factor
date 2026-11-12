import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import NotFound from '@/pages/not-found';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Cpu,
  Download,
  Gauge,
  KeyRound,
  LogIn,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Signal,
  UserPlus,
  Wifi,
  X,
} from 'lucide-react';
import { ActivityLogView, type ActivityRecord } from './components/analysis/ActivityLogView';
import { DERIV_SIGNUP_URL } from '@/lib/deriv-oauth';
import { parseDerivAccountBalances, type DerivAccountBalance } from '@/lib/deriv-accounts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MarketScannerDashboard,
} from './components/analysis/MarketScannerDashboard';
import {
  type PredictionOutcomeStart,
} from './components/analysis/DigitScannerView';
import {
  MATCH_EXECUTION_DELAY_TICKS,
  type LiveTick,
} from '@/lib/analysis-engine';
import {
  applyPredictionTick,
  parsePerformanceHistory,
  type PredictionOutcomeRecord,
} from '@/lib/performance';
import {
  isValidPipSize,
  parseTimestampedTick,
  parseTimestampedTickHistory,
} from '@/lib/market-data';
import {
  parseAppPreferences,
  type AppPreferences,
} from '@/lib/app-preferences';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

type ScannerSoundAlert = 'signal-found' | 'timer-ended';

function playTone(context: AudioContext, alert: ScannerSoundAlert) {
  const notes: {
    frequency: number;
    endFrequency?: number;
    delay: number;
    duration: number;
    wave: OscillatorType;
  }[] = alert === 'signal-found'
    ? [
      { frequency: 784, delay: 0, duration: 0.16, wave: 'triangle' },
      { frequency: 1175, delay: 0.13, duration: 0.16, wave: 'triangle' },
      { frequency: 1568, delay: 0.26, duration: 0.24, wave: 'triangle' },
    ]
    : [
      { frequency: 440, endFrequency: 330, delay: 0, duration: 0.34, wave: 'sawtooth' },
      { frequency: 330, endFrequency: 220, delay: 0.42, duration: 0.42, wave: 'sawtooth' },
    ];
  const startedAt = context.currentTime;

  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = startedAt + note.delay;
    const noteEnd = noteStart + note.duration;
    oscillator.type = note.wave;
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    if (note.endFrequency !== undefined) {
      oscillator.frequency.linearRampToValueAtTime(note.endFrequency, noteEnd);
    }
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(alert === 'signal-found' ? 0.12 : 0.08, noteStart + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteEnd + 0.01);
  }
}

type WorkspaceTheme = 'arctic' | 'nebula' | 'solar' | 'biolume' | 'lunar';
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface WorkspaceSettings {
  theme: WorkspaceTheme;
}

const SETTINGS_STORAGE_KEY = 'deriv-analysis-workspace-settings';
const APP_PREFERENCES_STORAGE_KEY = 'deriv-analysis-app-preferences-v1';
const PREDICTION_PERFORMANCE_STORAGE_KEY = 'deriv-analysis-prediction-performance-v1';
const PREDICTION_HISTORY_LIMIT = 500;
const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  theme: 'arctic',
};

function readWorkspaceSettings(): WorkspaceSettings {
  try {
    const storedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!storedSettings) {
      return DEFAULT_WORKSPACE_SETTINGS;
    }

    const parsed: unknown = JSON.parse(storedSettings);
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_WORKSPACE_SETTINGS;
    }

    const candidate = parsed as { theme?: unknown };
    const migratedTheme: Record<string, WorkspaceTheme> = {
      ocean: 'arctic',
      aurora: 'nebula',
      ember: 'solar',
      cyberpunk: 'biolume',
      obsidian: 'lunar',
    };
    const savedTheme = candidate.theme;
    return {
      theme: savedTheme === 'arctic'
        || savedTheme === 'nebula'
        || savedTheme === 'solar'
        || savedTheme === 'biolume'
        || savedTheme === 'lunar'
        ? savedTheme
        : typeof savedTheme === 'string' && migratedTheme[savedTheme]
          ? migratedTheme[savedTheme]
          : DEFAULT_WORKSPACE_SETTINGS.theme,
    };
  } catch (error) {
    console.warn('Unable to load saved workspace settings.', error);
    return DEFAULT_WORKSPACE_SETTINGS;
  }
}

const DERIV_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const TICK_WINDOW_SIZE = 1000;
const DEFAULT_MARKETS = [
  { symbol: 'R_100', label: 'Volatility 100 Index' },
  { symbol: 'R_75', label: 'Volatility 75 Index' },
  { symbol: '1HZ50V', label: 'Volatility 50 (1s) Index' },
  { symbol: 'BOOM500', label: 'Boom 500 Index' },
];

const DEFAULT_APP_PREFERENCES: AppPreferences = {
  marketSymbol: DEFAULT_MARKETS[0].symbol,
  autoScan: true,
  soundAlertsEnabled: false,
};

function readAppPreferences(): AppPreferences {
  try {
    const stored = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    if (!stored) return DEFAULT_APP_PREFERENCES;

    return parseAppPreferences(
      JSON.parse(stored) as unknown,
      DEFAULT_MARKETS.map(({ symbol }) => symbol),
    ) ?? DEFAULT_APP_PREFERENCES;
  } catch (error) {
    console.warn('Unable to load saved app preferences.', error);
    return DEFAULT_APP_PREFERENCES;
  }
}

type MarketOption = {
  symbol: string;
  label: string;
};

type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

interface LiveMarketData {
  price: string | null;
  lastDigit: number | null;
  tickCount: number;
  digitCounts: number[];
  scannerTicks: LiveTick[];
}

interface ScannedMarketData extends MarketOption {
  ticks: LiveTick[];
}

interface DerivFeedMessage {
  error?: { message?: string };
  req_id?: number;
  pip_size?: number;
  history?: { prices?: (string | number)[]; times?: number[] };
  tick?: { quote?: string | number; symbol?: string; pip_size?: number; epoch?: number };
  echo_req?: { ticks_history?: string };
  ping?: string;
  active_symbols?: {
    market?: string;
    underlying_symbol?: string;
    underlying_symbol_name?: string;
  }[];
}

const EMPTY_LIVE_MARKET_DATA: LiveMarketData = {
  price: null,
  lastDigit: null,
  tickCount: 0,
  digitCounts: Array(10).fill(0),
  scannerTicks: [],
};

function Home() {
  const [markets, setMarkets] = useState<MarketOption[]>(DEFAULT_MARKETS);
  const [appPreferences, setAppPreferences] = useState<AppPreferences>(readAppPreferences);
  const { marketSymbol, autoScan, soundAlertsEnabled } = appPreferences;
  const [notice, setNotice] = useState('');
  const [derivConnected, setDerivConnected] = useState(false);
  const [derivAccounts, setDerivAccounts] = useState<DerivAccountBalance[]>([]);
  const [selectedDerivAccount, setSelectedDerivAccount] = useState('');
  const [apiTokenDialogOpen, setApiTokenDialogOpen] = useState(false);
  const [apiTokenInput, setApiTokenInput] = useState('');
  const [apiTokenError, setApiTokenError] = useState('');
  const [apiTokenSubmitting, setApiTokenSubmitting] = useState(false);
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isAppInstalled, setIsAppInstalled] = useState(false);
  const [settings, setSettings] = useState<WorkspaceSettings>(readWorkspaceSettings);
  const [settingsDraft, setSettingsDraft] = useState<WorkspaceSettings>(settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  const [lastAction, setLastAction] = useState('Connecting to Deriv live feed');
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('connecting');
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedRetryKey, setFeedRetryKey] = useState(0);
  const [liveMarketData, setLiveMarketData] = useState(EMPTY_LIVE_MARKET_DATA);
  const [scannerTicksByMarket, setScannerTicksByMarket] = useState<Record<string, LiveTick[]>>({});
  const [scannerTickVersionsByMarket, setScannerTickVersionsByMarket] = useState<Record<string, number>>({});
  const [predictionOutcomes, setPredictionOutcomes] = useState<PredictionOutcomeRecord[]>([]);
  const [performanceClock, setPerformanceClock] = useState(Date.now());
  const hasLivePredictions = predictionOutcomes.some(
    (outcome) => outcome.status === 'tracking',
  );
  const [performanceHistoryLoaded, setPerformanceHistoryLoaded] = useState(false);
  const [scannerFeedStatus, setScannerFeedStatus] = useState<FeedStatus>('connecting');
  const [scannerFeedError, setScannerFeedError] = useState<string | null>(null);
  const market = markets.find((item) => item.symbol === marketSymbol) ?? DEFAULT_MARKETS[0];
  const activitySequence = useRef(3);
  const tickHistoryByMarket = useRef(new Map<string, LiveTick[]>());
  const activeFeedMarket = useRef(marketSymbol);
  const activePredictionOutcomesRef = useRef(new Map<string, PredictionOutcomeRecord>());
  const predictionOutcomeTimeoutsRef = useRef(new Map<string, number>());
  const performanceStorageErrorShownRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const [activityEntries, setActivityEntries] = useState<ActivityRecord[]>([
    { id: 2, time: 'READY', title: 'Connecting to live market feed', detail: 'Waiting for public Deriv tick data.', tone: 'blue' },
  ]);

  useEffect(() => {
    let active = true;
    const oauthError = new URLSearchParams(window.location.search).get('deriv_oauth_error');
    if (oauthError) {
      const messages: Record<string, string> = {
        authorization_denied: 'Deriv sign-in was cancelled.',
        authorization_failed: 'Deriv could not authorize this sign-in request.',
        invalid_scope: 'Enable the trade permission for this OAuth app in Deriv, then sign in again.',
        invalid_callback: 'Deriv returned an incomplete sign-in response. Please try again.',
        invalid_state: 'Deriv sign-in could not be verified. Please try again.',
        token_exchange_failed: 'Deriv could not complete sign-in. Please try again.',
      };
      setNotice(messages[oauthError] ?? 'Deriv sign-in failed. Please try again.');
      window.history.replaceState(null, '', '/');
    }

    void fetch('/api/oauth/deriv/session', { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          if (active) {
            setDerivConnected(false);
            setDerivAccounts([]);
          }
          return;
        }
        if (!response.ok) {
          const result: unknown = await response.json();
          const message = result
            && typeof result === 'object'
            && 'error' in result
            && typeof result.error === 'string'
            ? result.error
            : `Deriv session check failed with HTTP ${response.status}.`;
          throw new Error(message);
        }
        const result: unknown = await response.json();
        if (!result || typeof result !== 'object' || !('authenticated' in result) || result.authenticated !== true) {
          throw new Error('Deriv session check returned an invalid response.');
        }
        const accounts = parseDerivAccountBalances(result);
        if (active) {
          setDerivAccounts(accounts);
          setSelectedDerivAccount((current) => accounts.some((account) => account.accountId === current)
            ? current
            : (accounts.find((account) => account.accountType === 'real') ?? accounts[0])?.accountId ?? '');
          setDerivConnected(true);
          if (accounts.length === 0) setNotice('No active Deriv trading accounts were found.');
        }
      })
      .catch((error: unknown) => {
        console.error('Unable to check the Deriv login session.', error);
        if (active) setNotice(error instanceof Error ? error.message : 'Deriv login status is temporarily unavailable.');
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, JSON.stringify(appPreferences));
    } catch (error) {
      console.error('Unable to save app preferences.', error);
      setNotice('App preferences could not be saved in this browser.');
    }
  }, [appPreferences]);

  useEffect(() => {
    if (!soundAlertsEnabled || typeof window.AudioContext === 'undefined') return;

    const resumeAudioOnInteraction = () => {
      try {
        const context = audioContextRef.current ?? new window.AudioContext();
        audioContextRef.current = context;
        if (context.state === 'suspended') {
          void context.resume().catch((error: unknown) => {
            console.error('Unable to resume saved scanner audio alerts.', error);
          });
        }
      } catch (error) {
        console.error('Unable to initialize saved scanner audio alerts.', error);
      }
    };

    window.addEventListener('pointerdown', resumeAudioOnInteraction);
    window.addEventListener('keydown', resumeAudioOnInteraction);
    return () => {
      window.removeEventListener('pointerdown', resumeAudioOnInteraction);
      window.removeEventListener('keydown', resumeAudioOnInteraction);
    };
  }, [soundAlertsEnabled]);

  const toggleSoundAlerts = async () => {
    if (soundAlertsEnabled) {
      setAppPreferences((previous) => ({ ...previous, soundAlertsEnabled: false }));
      setNotice('Sound alerts disabled.');
      return;
    }

    if (typeof window.AudioContext === 'undefined') {
      setNotice('Sound alerts are not supported by this browser.');
      return;
    }

    try {
      const context = audioContextRef.current ?? new window.AudioContext();
      await context.resume();
      if (context.state !== 'running') {
        throw new Error('Audio playback did not start.');
      }
      audioContextRef.current = context;
      setAppPreferences((previous) => ({ ...previous, soundAlertsEnabled: true }));
      setNotice('Sound alerts enabled for signals and expired prediction timers.');
    } catch (error) {
      console.error('Unable to enable sound alerts.', error);
      setNotice('Sound alerts could not be enabled. Check browser audio permissions and try again.');
    }
  };

  const playScannerSoundAlert = (alert: ScannerSoundAlert) => {
    if (!soundAlertsEnabled) return;
    const context = audioContextRef.current;
    if (!context) {
      setNotice('Sound alerts are enabled, but audio is unavailable. Toggle alerts off and on to restore sound.');
      return;
    }

    const play = () => {
      try {
        playTone(context, alert);
      } catch (error) {
        console.error('Unable to play scanner sound alert.', error);
        setNotice('Scanner sound could not play. Toggle sound alerts off and on to restore audio.');
      }
    };

    if (context.state === 'suspended') {
      void context.resume().then(play).catch((error: unknown) => {
        console.error('Unable to resume audio for scanner alert.', error);
        setNotice('Scanner sound could not play. Toggle sound alerts off and on to restore audio.');
      });
      return;
    }

    play();
  };

  useEffect(() => {
    try {
      const savedHistory = localStorage.getItem(PREDICTION_PERFORMANCE_STORAGE_KEY);
      if (savedHistory) {
        const parsed: unknown = JSON.parse(savedHistory);
        const history = parsePerformanceHistory(parsed).slice(0, PREDICTION_HISTORY_LIMIT);
        if (!Array.isArray(parsed) || history.length !== parsed.length) {
          setNotice('Some saved performance records were invalid and have been skipped.');
        }
        setPredictionOutcomes(history);
      }
    } catch (error) {
      console.error('Unable to load saved prediction performance history.', error);
      setNotice('Saved prediction performance could not be loaded. New results will still be tracked.');
    } finally {
      setPerformanceHistoryLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!performanceHistoryLoaded) return;

    try {
      localStorage.setItem(
        PREDICTION_PERFORMANCE_STORAGE_KEY,
        JSON.stringify(predictionOutcomes.slice(0, PREDICTION_HISTORY_LIMIT)),
      );
      performanceStorageErrorShownRef.current = false;
    } catch (error) {
      console.error('Unable to save prediction performance history.', error);
      if (!performanceStorageErrorShownRef.current) {
        setNotice('Prediction results are tracked for this session but could not be saved to this browser.');
        performanceStorageErrorShownRef.current = true;
      }
    }
  }, [performanceHistoryLoaded, predictionOutcomes]);

  useEffect(() => {
    document.documentElement.dataset.workspaceTheme = settingsOpen
      ? settingsDraft.theme
      : settings.theme;
  }, [settings.theme, settingsDraft.theme, settingsOpen]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.getRegistrations()
        .then(async (registrations) => {
          const removed = await Promise.all(registrations.map((registration) => registration.unregister()));
          if (removed.some((success) => !success)) {
            throw new Error('An existing offline app worker could not be removed.');
          }
        })
        .catch((error: unknown) => {
          console.error('Unable to remove the PULSE-FACTOR offline app worker.', error);
        });
    }
    if ('caches' in window) {
      void caches.keys()
        .then((cacheNames) => Promise.all(
          cacheNames
            .filter((name) => name.startsWith('one-market-shell-') || name.startsWith('d-pulse-shell-'))
            .map((name) => caches.delete(name)),
        ))
        .catch((error: unknown) => {
          console.error('Unable to remove the cached PULSE-FACTOR app shell.', error);
        });
    }

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setIsAppInstalled(true);
      setInstallPromptEvent(null);
      setNotice('PULSE-FACTOR installed.');
    };

    setIsAppInstalled(window.matchMedia('(display-mode: standalone)').matches);
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const recordActivity = (title: string, detail: string, tone: ActivityRecord['tone'] = 'cyan') => {
    const id = activitySequence.current++;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setActivityEntries((entries) => [{ id, time, title, detail, tone }, ...entries].slice(0, 30));
    setLastAction(title);
  };

  const publishPredictionOutcome = (outcome: PredictionOutcomeRecord) => {
    setPredictionOutcomes((current) => [
      outcome,
      ...current.filter((item) => item.id !== outcome.id),
    ].slice(0, PREDICTION_HISTORY_LIMIT));
  };

  const finishPredictionOutcome = (
    outcomeId: string,
    status: 'complete' | 'replaced' | 'interrupted',
  ) => {
    const outcome = activePredictionOutcomesRef.current.get(outcomeId);
    if (!outcome) {
      return;
    }

    const timeout = predictionOutcomeTimeoutsRef.current.get(outcomeId);
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
      predictionOutcomeTimeoutsRef.current.delete(outcomeId);
    }
    publishPredictionOutcome({ ...outcome, status });
    activePredictionOutcomesRef.current.delete(outcomeId);
  };

  const interruptPredictionForMarket = (symbol: string) => {
    for (const outcome of activePredictionOutcomesRef.current.values()) {
      if (outcome.marketSymbol === symbol) {
        finishPredictionOutcome(outcome.id, 'interrupted');
      }
    }
  };

  const startPredictionOutcome = (prediction: PredictionOutcomeStart) => {
    const outcome: PredictionOutcomeRecord = {
      ...prediction,
      wins: 0,
      losses: 0,
      observedTicks: 0,
      pendingTicks: 0,
      squaredProbabilityError: 0,
      status: 'tracking',
    };
    activePredictionOutcomesRef.current.set(outcome.id, outcome);
    publishPredictionOutcome(outcome);
    const timeout = window.setTimeout(() => {
      if (activePredictionOutcomesRef.current.has(outcome.id)) {
        finishPredictionOutcome(outcome.id, 'complete');
      }
    }, Math.max(0, prediction.expiresAt - Date.now()));
    predictionOutcomeTimeoutsRef.current.set(outcome.id, timeout);
  };

  const resetPredictionOutcomes = () => {
    for (const timeout of predictionOutcomeTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    predictionOutcomeTimeoutsRef.current.clear();
    activePredictionOutcomesRef.current.clear();
    setPredictionOutcomes([]);
  };

  useEffect(() => {
    if (scannerFeedStatus !== 'live') {
      for (const outcome of activePredictionOutcomesRef.current.values()) {
        finishPredictionOutcome(outcome.id, 'interrupted');
      }
    }
  }, [scannerFeedStatus]);

  useEffect(() => {
    if (!hasLivePredictions) return;

    const timer = window.setInterval(() => setPerformanceClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLivePredictions]);

  useEffect(() => () => {
    for (const timeout of predictionOutcomeTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
  }, []);

  const selectMarket = (symbol: string) => {
    const selectedMarket = markets.find((item) => item.symbol === symbol);
    if (!selectedMarket || selectedMarket.symbol === marketSymbol) {
      return;
    }

    setLiveMarketData(EMPTY_LIVE_MARKET_DATA);
    setAppPreferences((previous) => ({ ...previous, marketSymbol: selectedMarket.symbol }));
    recordActivity('Live market changed', `Subscribing to ${selectedMarket.label}.`, 'cyan');
  };

  const submitApiToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setApiTokenError('');
    setApiTokenSubmitting(true);
    const token = apiTokenInput;
    setApiTokenInput('');
    try {
      const response = await fetch('/api/oauth/deriv/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        const result: unknown = await response.json();
        const message = result
          && typeof result === 'object'
          && 'error' in result
          && typeof result.error === 'string'
          ? result.error
          : 'Deriv could not verify this API token.';
        setApiTokenError(message);
        return;
      }

      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('authenticated' in result) || result.authenticated !== true) {
        throw new Error('Deriv API token verification returned an invalid response.');
      }

      const accounts = parseDerivAccountBalances(result);
      setDerivAccounts(accounts);
      setSelectedDerivAccount((accounts.find((account) => account.accountType === 'real') ?? accounts[0])?.accountId ?? '');
      setApiTokenDialogOpen(false);
      setDerivConnected(true);
      setNotice(accounts.length > 0
        ? 'Connected to Deriv with an API token.'
        : 'Connected to Deriv, but no active trading accounts were found.');
    } catch (error) {
      console.error('Unable to verify the Deriv API token.', error);
      setApiTokenError('Could not reach the server to verify your token. Try again shortly.');
    } finally {
      setApiTokenSubmitting(false);
    }
  };

  const installApp = async () => {
    if (!installPromptEvent) {
      setNotice('To install PULSE-FACTOR, open your browser menu and select Install app or Add to Home Screen.');
      return;
    }

    try {
      await installPromptEvent.prompt();
      const { outcome } = await installPromptEvent.userChoice;
      setInstallPromptEvent(null);
      if (outcome === 'accepted') {
        setNotice('PULSE-FACTOR is installing.');
      }
    } catch (error) {
      console.error('Unable to start PULSE-FACTOR installation.', error);
      setNotice('PULSE-FACTOR could not be installed. Try the install option in your browser menu.');
    }
  };

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let reconnectAttempt = 0;
    let pipSize = 2;
    let ticks = tickHistoryByMarket.current.get(marketSymbol) ?? [];

    setFeedStatus('connecting');
    if (activeFeedMarket.current !== marketSymbol) {
      activeFeedMarket.current = marketSymbol;
      setFeedError(null);
    }

    const stopHeartbeat = () => {
      if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };

    const publishData = () => {
      const digitCounts = Array(10).fill(0) as number[];
      for (const tick of ticks) {
        digitCounts[tick.digit] += 1;
      }

      setLiveMarketData({
        price: ticks.at(-1)?.price ?? null,
        lastDigit: ticks.at(-1)?.digit ?? null,
        tickCount: ticks.length,
        digitCounts,
        scannerTicks: ticks,
      });
    };

    publishData();

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) {
        return;
      }

      setFeedStatus('reconnecting');
      const delay = Math.min(1000 * (2 ** reconnectAttempt), 30000);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      setFeedStatus(reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
      try {
        socket = new WebSocket(DERIV_WS_URL);
      } catch {
        setFeedStatus('error');
        setFeedError('Could not open a Deriv WebSocket connection.');
        scheduleReconnect();
        return;
      }

      const currentSocket = socket;
      let lastMessageAt = Date.now();
      currentSocket.onopen = () => {
        if (disposed || currentSocket !== socket) {
          return;
        }

        lastMessageAt = Date.now();
        try {
          currentSocket.send(JSON.stringify({
            ticks_history: marketSymbol,
            count: TICK_WINDOW_SIZE,
            end: 'latest',
            style: 'ticks',
            subscribe: 1,
          }));
          currentSocket.send(JSON.stringify({ active_symbols: 'full' }));
        } catch (error) {
          console.error('Unable to subscribe to the Deriv live feed.', error);
          setFeedStatus('error');
          setFeedError('The Deriv WebSocket opened but rejected its market subscriptions.');
          currentSocket.close();
          return;
        }
        stopHeartbeat();
        heartbeatTimer = window.setInterval(() => {
          if (disposed || currentSocket !== socket || currentSocket.readyState !== WebSocket.OPEN) {
            return;
          }
          if (Date.now() - lastMessageAt > 45000) {
            currentSocket.close();
            return;
          }
          currentSocket.send(JSON.stringify({ ping: 1 }));
        }, 20000);
      };

      currentSocket.onmessage = (event: MessageEvent<string>) => {
        if (disposed || currentSocket !== socket) {
          return;
        }
        lastMessageAt = Date.now();

        if (typeof event.data !== 'string') {
          setFeedStatus('error');
          setFeedError('Received an unreadable response from the Deriv feed.');
          currentSocket.close();
          return;
        }

        let message: DerivFeedMessage;
        try {
          message = JSON.parse(event.data) as DerivFeedMessage;
        } catch {
          setFeedStatus('error');
          setFeedError('Received an invalid response from the Deriv feed.');
          currentSocket.close();
          return;
        }

        if (message.error) {
          setFeedStatus('error');
          setFeedError(message.error.message || 'Deriv rejected the live tick request.');
          stopHeartbeat();
          currentSocket.close();
          return;
        }

        if (message.ping !== undefined) {
          return;
        }

        if (message.active_symbols) {
          const volatilityMarkets = message.active_symbols
            .filter((item): item is {
              market: string;
              underlying_symbol: string;
              underlying_symbol_name: string;
            } => (
              item.market === 'synthetic_index'
              && typeof item.underlying_symbol === 'string'
              && typeof item.underlying_symbol_name === 'string'
              && /^Volatility\s/i.test(item.underlying_symbol_name)
            ))
            .map((item) => ({
              symbol: item.underlying_symbol,
              label: item.underlying_symbol_name,
            }));
          const availableMarkets = [
            ...volatilityMarkets,
            ...DEFAULT_MARKETS.filter((item) => !volatilityMarkets.some((volatility) => volatility.symbol === item.symbol)),
          ].sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
          setMarkets(availableMarkets);
        }

        if (message.pip_size !== undefined) {
          if (!isValidPipSize(message.pip_size)) {
            setFeedError(`Deriv returned invalid price precision for ${market.label}; the affected quote was ignored.`);
            return;
          }
          pipSize = message.pip_size;
        }

        if (message.history?.prices) {
          const historyPrices = message.history.prices.slice(-TICK_WINDOW_SIZE);
          const historyTimes = message.history.times?.slice(-historyPrices.length);
          const history = historyTimes
            ? parseTimestampedTickHistory(historyPrices, historyTimes, pipSize, marketSymbol)
            : null;
          if (!history) {
            setFeedError(`Deriv returned invalid, incomplete, or out-of-order timestamped tick history for ${market.label}; the history was ignored.`);
            return;
          }
          ticks = history.map(({ price, lastDigit, epoch, symbol }) => ({
            price,
            digit: lastDigit,
            epoch,
            symbol,
          }));
          tickHistoryByMarket.current.set(marketSymbol, ticks);
          publishData();
          setFeedStatus('live');
          setFeedError(null);
          reconnectAttempt = 0;
          return;
        }

        if (message.tick?.quote !== undefined) {
          if (message.tick.symbol !== undefined && message.tick.symbol !== marketSymbol) {
            setFeedError(`Deriv returned a tick for ${message.tick.symbol} on the ${market.label} subscription; the tick was ignored.`);
            return;
          }
          if (message.tick.pip_size !== undefined) {
            if (!isValidPipSize(message.tick.pip_size)) {
              setFeedError(`Deriv returned invalid price precision for ${market.label}; the affected tick was ignored.`);
              return;
            }
            pipSize = message.tick.pip_size;
          }
          const tick = parseTimestampedTick(
            message.tick.quote,
            pipSize,
            message.tick.epoch ?? Number.NaN,
            marketSymbol,
            ticks.at(-1)?.epoch,
          );
          if (!tick) {
            setFeedError(`Deriv returned an invalid, stale, duplicate, or out-of-order tick for ${market.label}; the affected tick was ignored.`);
            return;
          }
          ticks = [...ticks, {
            price: tick.price,
            digit: tick.lastDigit,
            epoch: tick.epoch,
            symbol: tick.symbol,
          }].slice(-TICK_WINDOW_SIZE);
          tickHistoryByMarket.current.set(marketSymbol, ticks);
          publishData();
          setFeedStatus('live');
          setFeedError(null);
          reconnectAttempt = 0;
        }
      };

      currentSocket.onerror = () => {
        if (disposed || currentSocket !== socket) {
          return;
        }
        setFeedStatus('error');
        setFeedError('Unable to reach Deriv. Check your internet connection and WebSocket access.');
        stopHeartbeat();
        currentSocket.close();
      };

      currentSocket.onclose = () => {
        stopHeartbeat();
        if (!disposed && currentSocket === socket) {
          scheduleReconnect();
        }
      };
    };
    let lastForcedReconnectAt = 0;
    const reconnectNow = () => {
      if (disposed || Date.now() - lastForcedReconnectAt < 5000) {
        return;
      }
      lastForcedReconnectAt = Date.now();
      reconnectAttempt = 0;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        socket = null;
      }
      stopHeartbeat();
      connect();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) {
        reconnectNow();
      }
    };

    window.addEventListener('online', reconnectNow);
    window.addEventListener('focus', reconnectNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    connect();

    return () => {
      disposed = true;
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('focus', reconnectNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      stopHeartbeat();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [marketSymbol, feedRetryKey]);

  const volatilityMarkets = markets.filter((item) => /^Volatility\s/i.test(item.label));

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let reconnectAttempt = 0;
    let lastForcedReconnectAt = 0;
    let lastMessageAt = Date.now();
    const requestIdToSymbol = new Map<number, string>();
    const pipSizeBySymbol = new Map<string, number>();
    const ticksBySymbol = new Map<string, LiveTick[]>();
    const tickVersionsBySymbol = new Map<string, number>();

    setScannerFeedStatus('connecting');
    setScannerFeedError(null);
    setScannerTickVersionsByMarket(
      Object.fromEntries(volatilityMarkets.map((item) => [item.symbol, 0])),
    );
    setScannerTicksByMarket(
      Object.fromEntries(volatilityMarkets.map((item) => [item.symbol, []])),
    );

    const stopHeartbeat = () => {
      if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) {
        return;
      }
      setScannerFeedStatus('reconnecting');
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, Math.min(1000 * (2 ** reconnectAttempt++), 30000));
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      setScannerFeedStatus(reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
      try {
        socket = new WebSocket(DERIV_WS_URL);
      } catch {
        setScannerFeedStatus('error');
        setScannerFeedError('Could not open a Deriv scanner connection.');
        scheduleReconnect();
        return;
      }

      const currentSocket = socket;
      currentSocket.onopen = () => {
        if (disposed || currentSocket !== socket) {
          return;
        }

        lastMessageAt = Date.now();
        try {
          volatilityMarkets.forEach(({ symbol }, index) => {
            const reqId = index + 1;
            requestIdToSymbol.set(reqId, symbol);
            currentSocket.send(JSON.stringify({
              req_id: reqId,
              ticks_history: symbol,
              count: TICK_WINDOW_SIZE,
              end: 'latest',
              style: 'ticks',
              subscribe: 1,
            }));
          });
        } catch (error) {
          console.error('Unable to subscribe to Deriv scanner markets.', error);
          setScannerFeedStatus('error');
          setScannerFeedError('The Deriv scanner connection opened but rejected its market subscriptions.');
          currentSocket.close();
          return;
        }

        stopHeartbeat();
        heartbeatTimer = window.setInterval(() => {
          if (disposed || currentSocket !== socket || currentSocket.readyState !== WebSocket.OPEN) {
            return;
          }
          if (Date.now() - lastMessageAt > 45000) {
            currentSocket.close();
            return;
          }
          currentSocket.send(JSON.stringify({ ping: 1 }));
        }, 20000);
      };

      currentSocket.onmessage = (event: MessageEvent<string>) => {
        if (disposed || currentSocket !== socket) {
          return;
        }
        lastMessageAt = Date.now();
        if (typeof event.data !== 'string') {
          setScannerFeedError('Received an unreadable response from the market scanner.');
          return;
        }

        let message: DerivFeedMessage;
        try {
          message = JSON.parse(event.data) as DerivFeedMessage;
        } catch {
          setScannerFeedError('Received an invalid response from the market scanner.');
          return;
        }

        if (message.ping !== undefined) {
          return;
        }

        const requestSymbol = typeof message.req_id === 'number'
          ? requestIdToSymbol.get(message.req_id)
          : undefined;
        if (message.error) {
          const failedMarket = volatilityMarkets.find((item) => item.symbol === requestSymbol);
          if (requestSymbol) interruptPredictionForMarket(requestSymbol);
          setScannerFeedError(
            failedMarket
              ? `Could not scan ${failedMarket.label}: ${message.error.message || 'Deriv rejected its tick request.'}`
              : message.error.message || 'Deriv rejected a scanner tick request.',
          );
          return;
        }

        const echoedSymbol = typeof message.echo_req?.ticks_history === 'string'
          ? message.echo_req.ticks_history
          : undefined;
        const taggedSymbols = [requestSymbol, message.tick?.symbol, echoedSymbol]
          .filter((tag): tag is string => typeof tag === 'string');
        if (new Set(taggedSymbols).size > 1) {
          taggedSymbols.forEach(interruptPredictionForMarket);
          setScannerFeedError(
            `Deriv returned conflicting market symbols for one scanner response (${[...new Set(taggedSymbols)].join(', ')}); the response was ignored.`,
          );
          return;
        }

        const symbol = message.tick?.symbol
          ?? requestSymbol
          ?? echoedSymbol;
        if (!symbol || !volatilityMarkets.some((item) => item.symbol === symbol)) {
          if (symbol) {
            setScannerFeedError(`Deriv returned an unrequested market (${symbol}) on the scanner feed; the response was ignored.`);
          }
          return;
        }

        if (message.pip_size !== undefined) {
          if (!isValidPipSize(message.pip_size)) {
            const failedMarket = volatilityMarkets.find((item) => item.symbol === symbol);
            interruptPredictionForMarket(symbol);
            setScannerFeedError(`Deriv returned invalid price precision for ${failedMarket?.label ?? symbol}; the affected response was ignored.`);
            return;
          }
          pipSizeBySymbol.set(symbol, message.pip_size);
        }
        if (message.tick?.pip_size !== undefined) {
          if (!isValidPipSize(message.tick.pip_size)) {
            const failedMarket = volatilityMarkets.find((item) => item.symbol === symbol);
            interruptPredictionForMarket(symbol);
            setScannerFeedError(`Deriv returned invalid price precision for ${failedMarket?.label ?? symbol}; the affected tick was ignored.`);
            return;
          }
          pipSizeBySymbol.set(symbol, message.tick.pip_size);
        }
        const pipSize = pipSizeBySymbol.get(symbol) ?? 2;

        if (message.history?.prices) {
          const historyPrices = message.history.prices.slice(-TICK_WINDOW_SIZE);
          const historyTimes = message.history.times?.slice(-historyPrices.length);
          const parsedHistory = historyTimes
            ? parseTimestampedTickHistory(historyPrices, historyTimes, pipSize, symbol)
            : null;
          if (!parsedHistory) {
            const failedMarket = volatilityMarkets.find((item) => item.symbol === symbol);
            interruptPredictionForMarket(symbol);
            setScannerFeedError(`Deriv returned invalid, incomplete, or out-of-order timestamped tick history for ${failedMarket?.label ?? symbol}; the history was ignored.`);
            return;
          }
          const history = parsedHistory
            .map(({ price, lastDigit, epoch, symbol: tickSymbol }) => ({
              price,
              digit: lastDigit,
              epoch,
              symbol: tickSymbol,
            }));
          ticksBySymbol.set(symbol, history);
          setScannerTicksByMarket((current) => ({ ...current, [symbol]: history }));
          setScannerFeedStatus('live');
          setScannerFeedError(null);
          reconnectAttempt = 0;
          return;
        }

        if (message.tick?.quote !== undefined) {
          const tick = parseTimestampedTick(
            message.tick.quote,
            pipSize,
            message.tick.epoch ?? Number.NaN,
            symbol,
            ticksBySymbol.get(symbol)?.at(-1)?.epoch,
          );
          if (!tick) {
            const failedMarket = volatilityMarkets.find((item) => item.symbol === symbol);
            interruptPredictionForMarket(symbol);
            setScannerFeedError(`Deriv returned an invalid, stale, duplicate, or out-of-order tick for ${failedMarket?.label ?? symbol}; the affected tick was ignored.`);
            return;
          }
          for (const predictionOutcome of activePredictionOutcomesRef.current.values()) {
            if (predictionOutcome.marketSymbol !== symbol) continue;
            if (Date.now() >= predictionOutcome.expiresAt) {
              finishPredictionOutcome(predictionOutcome.id, 'complete');
            } else {
              const { outcome: updatedOutcome } = applyPredictionTick(
                predictionOutcome,
                tick.lastDigit,
              );
              activePredictionOutcomesRef.current.set(updatedOutcome.id, updatedOutcome);
              publishPredictionOutcome(updatedOutcome);
            }
          }

          const ticks = [...(ticksBySymbol.get(symbol) ?? []), {
            price: tick.price,
            digit: tick.lastDigit,
            epoch: tick.epoch,
            symbol: tick.symbol,
          }]
            .slice(-TICK_WINDOW_SIZE);
          ticksBySymbol.set(symbol, ticks);
          const tickVersion = (tickVersionsBySymbol.get(symbol) ?? 0) + 1;
          tickVersionsBySymbol.set(symbol, tickVersion);
          setScannerTicksByMarket((current) => ({ ...current, [symbol]: ticks }));
          setScannerTickVersionsByMarket((current) => ({ ...current, [symbol]: tickVersion }));
          setScannerFeedStatus('live');
          setScannerFeedError(null);
          reconnectAttempt = 0;
        }
      };

      currentSocket.onerror = () => {
        if (disposed || currentSocket !== socket) {
          return;
        }
        setScannerFeedStatus('error');
        setScannerFeedError('Unable to reach Deriv market scanner. Check WebSocket access.');
        stopHeartbeat();
        currentSocket.close();
      };

      currentSocket.onclose = () => {
        stopHeartbeat();
        if (!disposed && currentSocket === socket) {
          scheduleReconnect();
        }
      };
    };

    const reconnectNow = () => {
      if (disposed || Date.now() - lastForcedReconnectAt < 5000) {
        return;
      }
      lastForcedReconnectAt = Date.now();
      reconnectAttempt = 0;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        socket = null;
      }
      stopHeartbeat();
      connect();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) {
        reconnectNow();
      }
    };

    window.addEventListener('online', reconnectNow);
    window.addEventListener('focus', reconnectNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    connect();

    return () => {
      disposed = true;
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('focus', reconnectNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      stopHeartbeat();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [volatilityMarkets.map(({ symbol }) => symbol).join(',')]);

  const reconnectFeed = () => {
    setFeedError(null);
    setFeedStatus('connecting');
    setFeedRetryKey((key) => key + 1);
    recordActivity('Live feed reconnecting', `Reconnecting to ${market.label}.`);
  };

  const disconnectDeriv = async () => {
    try {
      const response = await fetch('/api/oauth/deriv/session', { method: 'DELETE' });
      if (!response.ok) throw new Error(`Deriv logout failed with HTTP ${response.status}.`);
      setDerivConnected(false);
      setDerivAccounts([]);
      setSelectedDerivAccount('');
      setSettingsOpen(false);
      setNotice('Disconnected from Deriv.');
    } catch (error) {
      console.error('Unable to clear the Deriv session.', error);
      setNotice('Deriv could not be disconnected. Please try again.');
    }
  };

  const saveSettings = () => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settingsDraft));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown storage error';
      setNotice(`Settings could not be saved: ${message}`);
      return;
    }

    setSettings(settingsDraft);
    setSettingsOpen(false);
    recordActivity('Workspace settings saved', `Theme: ${settingsDraft.theme}.`);
    setNotice('Workspace appearance settings saved. Each analysis engine keeps its own contract and signal settings.');
  };

  const rankedUniqueCounts = [...new Set(liveMarketData.digitCounts)].sort((left, right) => right - left);
  const highestCount = rankedUniqueCounts[0] ?? 0;
  const secondHighestCount = rankedUniqueCounts[1];
  const lowestCount = rankedUniqueCounts.at(-1) ?? 0;
  const secondLowestCount = rankedUniqueCounts.at(-2);
  const rankedDigits = liveMarketData.digitCounts
    .map((count, digit) => ({ digit, count }))
    .sort((left, right) => right.count - left.count || left.digit - right.digit);
  const mostFrequentDigits = rankedDigits.slice(0, 3);
  const leastFrequentDigit = rankedDigits.at(-1);
  const digitRankByDigit = new Map(
    liveMarketData.digitCounts.map((count, digit) => {
      if (liveMarketData.tickCount === 0) {
        return [digit, 'unranked'] as const;
      }
      if (count === highestCount) {
        return [digit, 'highest'] as const;
      }
      if (rankedUniqueCounts.length >= 3 && count === secondHighestCount) {
        return [digit, 'second-highest'] as const;
      }
      if (count === lowestCount) {
        return [digit, 'lowest'] as const;
      }
      if (rankedUniqueCounts.length >= 4 && count === secondLowestCount) {
        return [digit, 'second-lowest'] as const;
      }
      return [digit, 'middle'] as const;
    }),
  );
  const feedStatusLabel = feedStatus === 'live'
    ? 'LIVE'
    : feedStatus === 'reconnecting'
      ? 'RECONNECTING'
      : feedStatus === 'error'
        ? 'FEED ERROR'
        : 'CONNECTING';
  const recentPredictionOutcomes = [...predictionOutcomes]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, 8);
  const selectedAccount = derivAccounts.find((account) => account.accountId === selectedDerivAccount);
  return (
    <main className="dashboard-backdrop min-h-[100dvh] px-3 pb-8 pt-3 text-[#dce6ef] sm:px-3 sm:pt-4">
      <div className="mx-auto max-w-[1440px]">
        <header className="topbar mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[#263441] pb-3 sm:mb-6 sm:pb-4">
          <div className="order-1 flex min-w-0 flex-wrap items-center gap-3 sm:order-1">
            <img src="/icons/pulsefactor-192.png" alt="" className="h-12 w-12 shrink-0 rounded-xl border border-[#d6ad51]/50 object-cover shadow-[0_0_18px_rgba(177,70,255,.25)]" />
            <div>
              <span className="font-display text-[18px] font-bold leading-none tracking-[.08em] text-[#f2f0e9] sm:text-[22px]">PULSE-FACTOR</span>
              <p className="mt-1 font-mono-ui text-[8px] tracking-[.12em] text-[#7f929e]">LIVE MARKET ANALYSIS</p>
            </div>
          </div>
          <div className="order-2 ml-auto flex w-full flex-col items-end gap-2 sm:order-3 sm:w-auto sm:flex-row sm:items-center">
            <div className="order-1 flex w-full flex-wrap items-center justify-end gap-2 sm:order-2 sm:w-auto">
              {!isAppInstalled && (
                <button type="button" onClick={installApp} data-testid="button-install-app" className="flex h-9 items-center gap-1.5 rounded-lg border border-[#1c7778]/60 bg-[#103334]/70 px-2.5 font-mono-ui text-[8px] font-bold tracking-wider text-[#71e2d6] transition hover:border-[#54d8d6] hover:bg-[#164348] sm:px-3">
                  <Download size={13} /> INSTALL APP
                </button>
              )}
              <div data-testid="status-market-feed" aria-live="polite" className="preview-badge flex items-center gap-2 rounded-full border border-[#1d7577]/55 bg-[#0d3338]/50 px-3 py-1.5">
                <span className={`pulse-dot h-1.5 w-1.5 rounded-full ${feedStatus === 'live' ? 'bg-[#42d8d2]' : feedStatus === 'error' ? 'bg-[#ef4444]' : 'bg-[#d6ad51]'}`} />
                <span className="font-mono-ui text-[10px] tracking-[.12em] text-[#6de4dc]">{feedStatusLabel}</span>
              </div>
              <button type="button" onClick={() => { void toggleSoundAlerts(); }} aria-label={soundAlertsEnabled ? 'Disable sound alerts' : 'Enable sound alerts'} aria-pressed={soundAlertsEnabled} title={soundAlertsEnabled ? 'Sound alerts on' : 'Sound alerts off'} data-testid="button-notifications" className={`grid h-9 w-9 place-items-center rounded-lg border transition ${soundAlertsEnabled ? 'border-[#1c9a7a] bg-[#10382f] text-[#67e8b5]' : 'border-[#263441] bg-[#101a22] text-[#a5b2bc] hover:border-[#447985] hover:text-[#54d8d6]'}`}>
                <Bell size={16} />
              </button>
              <button type="button" onClick={() => { setSettingsDraft(settings); setSettingsOpen(true); }} aria-label="Settings" data-testid="button-settings" className="grid h-9 w-9 place-items-center rounded-lg border border-[#263441] bg-[#101a22] text-[#a5b2bc] transition hover:border-[#447985] hover:text-[#54d8d6]">
                <Settings2 size={16} />
              </button>
            </div>
            {!derivConnected && (
              <div className="order-2 flex w-full flex-wrap items-center justify-end gap-2 sm:order-1 sm:w-auto">
                <a href="/api/oauth/deriv/login" data-testid="button-deriv-login" className="flex h-9 items-center gap-1.5 rounded-lg border border-[#7651bc]/70 bg-[#261b3d]/80 px-2.5 font-mono-ui text-[8px] font-bold tracking-wider text-[#d5b9ff] transition hover:border-[#ad7cff] hover:bg-[#352255] sm:px-3">
                  <LogIn size={13} /> DERIV LOGIN
                </a>
                <a href={DERIV_SIGNUP_URL} target="_blank" rel="noopener noreferrer" data-testid="button-deriv-signup" className="flex h-9 items-center gap-1.5 rounded-lg border border-[#d6ad51]/60 bg-[#342918]/75 px-2.5 font-mono-ui text-[8px] font-bold tracking-wider text-[#f3d982] transition hover:border-[#ffdc72] hover:bg-[#4a381d] sm:px-3">
                  <UserPlus size={13} /> SIGN UP
                </a>
              </div>
            )}
          </div>
          {derivConnected && selectedAccount && (
            <div className="order-3 flex w-full justify-start sm:order-2 sm:w-auto">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Choose Deriv account"
                    data-account-selector="true"
                    data-testid="status-deriv-balance"
                    className="group relative flex min-h-12 items-center gap-3 overflow-hidden rounded-xl border border-[#25877e]/60 bg-[linear-gradient(120deg,rgba(10,44,47,.96),rgba(10,25,37,.96))] px-3 py-1.5 text-left shadow-[0_0_22px_rgba(27,203,177,.08)] transition hover:border-[#54d8c6] hover:shadow-[0_0_26px_rgba(27,203,177,.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#54d8c6]/70"
                  >
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${
                      selectedAccount.accountType === 'real'
                        ? 'border-[#f3c866]/45 bg-[#59431d]/45 text-[#f4d583]'
                        : 'border-[#55d9bf]/40 bg-[#124a3c]/55 text-[#80efcb]'
                    }`}>
                      <span className="h-2 w-2 rounded-full bg-current shadow-[0_0_10px_currentColor]" />
                    </span>
                    <span className="min-w-0">
                      <span className={`block truncate font-mono-ui text-[9px] font-bold tracking-[.12em] ${
                        selectedAccount.accountType === 'real' ? 'text-[#f4d583]' : 'text-[#8ce9ca]'
                      }`}>
                        {selectedAccount.accountType === 'real' ? 'REAL ACCOUNT' : 'DEMO ACCOUNT'}
                      </span>
                      <span className="mt-0.5 block whitespace-nowrap font-mono-ui text-[12px] font-extrabold tabular-nums text-[#f0f7f5]" data-testid="text-deriv-balance">
                        {new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(selectedAccount.balance)} {selectedAccount.currency || 'units'}
                      </span>
                    </span>
                    <ChevronDown size={15} className="ml-1 shrink-0 text-[#9bbdb7] transition-transform group-data-[state=open]:rotate-180" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  sideOffset={8}
                  className="w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-[#2b6567] bg-[#091820]/[.98] p-2 text-[#e8f4f1] shadow-[0_18px_60px_rgba(0,0,0,.62),0_0_28px_rgba(36,196,177,.12)] backdrop-blur-xl"
                >
                  <div className="px-2 pb-2 pt-1">
                    <p className="font-mono-ui text-[8px] font-bold tracking-[.2em] text-[#6f9998]">SWITCH ACCOUNT</p>
                    <p className="mt-1 text-[10px] text-[#8fa7a9]">Choose a balance to view</p>
                  </div>
                  <div className="space-y-1">
                    {derivAccounts.map((account) => {
                      const isSelected = account.accountId === selectedDerivAccount;
                      const isReal = account.accountType === 'real';
                      return (
                        <DropdownMenuItem
                          key={account.accountId}
                          onSelect={() => setSelectedDerivAccount(account.accountId)}
                          data-testid={`option-deriv-account-${account.accountType}`}
                          aria-current={isSelected ? 'true' : undefined}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-3 transition focus:bg-[#143236] focus:text-white ${
                            isSelected
                              ? 'border-[#267b74]/70 bg-[#103130]/80'
                              : 'border-transparent bg-[#101f28]/65 hover:border-[#28474d] hover:bg-[#122a32]'
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-3">
                            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${
                              isReal
                                ? 'border-[#e8bd59]/35 bg-[#473719]/45 text-[#f3d37e]'
                                : 'border-[#55d9bf]/35 bg-[#104537]/50 text-[#83e6c6]'
                            }`}>
                              <span className="h-2 w-2 rounded-full bg-current shadow-[0_0_10px_currentColor]" />
                            </span>
                            <span className="min-w-0">
                              <span className={`block font-mono-ui text-[9px] font-bold tracking-[.1em] ${
                                isReal ? 'text-[#f1d17a]' : 'text-[#85e4c4]'
                              }`}>
                                {isReal ? 'REAL ACCOUNT' : 'DEMO ACCOUNT'}
                              </span>
                              <span className="mt-1 block truncate text-[9px] text-[#779096]">
                                {account.accountId}
                              </span>
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="text-right">
                              <span className="block font-mono-ui text-[11px] font-bold tabular-nums text-[#edf5f2]">
                                {new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(account.balance)}
                              </span>
                              <span className="mt-0.5 block font-mono-ui text-[8px] font-bold tracking-wider text-[#81999b]">
                                {account.currency || 'UNITS'}
                              </span>
                            </span>
                            {isSelected && <Check size={15} className="text-[#63dfc2]" />}
                          </span>
                        </DropdownMenuItem>
                      );
                    })}
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </header>

        <nav className="section-nav mb-4 flex items-center gap-2 border-b border-[#263441] pb-2 sm:mb-5" aria-label="Main navigation">
          <a href="#workspace" data-testid="tab-workspace" aria-current="page" className="nav-current relative inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#1c7778]/60 bg-[#103334]/70 px-3 py-2 font-mono-ui text-[9px] font-bold tracking-wider text-[#71e2d6] transition hover:border-[#54d8d6] hover:bg-[#164348]">
            <Activity size={13} /> WORKSPACE
          </a>
        </nav>

        {notice && <div role="status" data-testid="status-notice" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-[#1f7374]/50 bg-[#0e3034] px-3 py-2.5 text-[11px] text-[#9be7df] rise-in"><span>{notice}</span><button type="button" onClick={() => setNotice('')} data-testid="button-dismiss-notice" aria-label="Dismiss notice"><X size={14} /></button></div>}

        <Dialog
          open={apiTokenDialogOpen}
          onOpenChange={(open) => {
            setApiTokenDialogOpen(open);
            if (!open) {
              setApiTokenInput('');
              setApiTokenError('');
            }
          }}
        >
          <DialogContent className="w-[calc(100%-1.5rem)] max-w-md border-[#276e79] bg-[#07141f] p-5 text-[#dce6ef] shadow-[0_0_40px_rgba(16,190,205,.16)] sm:p-6">
            <DialogHeader className="pr-7 text-left">
              <DialogTitle className="flex items-center gap-2 font-display text-2xl tracking-wide text-[#eff4ff]">
                <KeyRound size={20} className="text-[#43d6e5]" /> CONNECT WITH API TOKEN
              </DialogTitle>
              <DialogDescription className="text-xs leading-relaxed text-[#8fa4b2]">
                Paste a Deriv personal API token. It is sent securely to the server for verification and kept in an HttpOnly session cookie, not browser storage.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={(event) => { void submitApiToken(event); }} className="space-y-4">
              <label className="block space-y-2">
                <span className="block font-mono-ui text-[10px] font-bold tracking-[.12em] text-[#82dce5]">DERIV API TOKEN</span>
                <input
                  type="password"
                  name="deriv-api-token"
                  value={apiTokenInput}
                  onChange={(event) => setApiTokenInput(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={8192}
                  data-testid="input-deriv-api-token"
                  aria-invalid={Boolean(apiTokenError)}
                  aria-describedby={apiTokenError ? 'deriv-api-token-error' : 'deriv-api-token-help'}
                  className="w-full rounded-lg border border-[#285264] bg-[#0b202c] px-3 py-2.5 font-mono-ui text-sm text-[#e1f3f5] outline-none focus:border-[#3dd5e3]"
                  placeholder="Paste your token"
                />
              </label>
              <p id="deriv-api-token-help" className="text-[11px] leading-relaxed text-[#8299a5]">
                Create a token with only the permissions you need in your Deriv account.
                {' '}
                <a href="https://app.deriv.com/account/api-token" target="_blank" rel="noopener noreferrer" className="font-semibold text-[#71dbe4] underline underline-offset-2 hover:text-[#b4f7ff]">Manage API tokens</a>
              </p>
              {apiTokenError && <p id="deriv-api-token-error" role="alert" className="text-xs text-[#ffaaa0]">{apiTokenError}</p>}
              <DialogFooter className="gap-2 sm:flex-row">
                <button type="button" onClick={() => setApiTokenDialogOpen(false)} disabled={apiTokenSubmitting} data-testid="button-cancel-api-token" className="rounded-lg border border-[#29404d] bg-[#101d27] px-4 py-2 text-xs font-bold text-[#aebec8] transition hover:border-[#527181] disabled:opacity-50">
                  CANCEL
                </button>
                <button type="submit" disabled={apiTokenSubmitting || apiTokenInput.length === 0} data-testid="button-submit-api-token" className="rounded-lg border border-[#1e9e9c] bg-gradient-to-r from-[#087b83] to-[#136a91] px-4 py-2 text-xs font-extrabold tracking-wide text-white shadow-[0_4px_16px_rgba(24,184,190,.16)] transition hover:brightness-110 disabled:cursor-wait disabled:opacity-50">
                  {apiTokenSubmitting ? 'VERIFYING…' : 'CONNECT'}
                </button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="w-[calc(100%-1.5rem)] max-w-md border-[#246778] bg-[#07141f] p-5 text-[#dce6ef] shadow-[0_0_40px_rgba(16,190,205,.16)] sm:p-6">
            <DialogHeader className="pr-7 text-left">
              <DialogTitle className="flex items-center gap-2 font-display text-2xl tracking-wide text-[#eff4ff]">
                <Settings2 size={20} className="text-[#43d6e5]" /> WORKSPACE SETTINGS
              </DialogTitle>
              <DialogDescription className="text-xs leading-relaxed text-[#8fa4b2]">
                Choose the workspace appearance. Contract and signal settings are managed independently in each engine dashboard.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              {derivConnected && (
                <section className="flex items-center justify-between gap-3 rounded-lg border border-[#7651bc]/40 bg-[#261b3d]/40 p-3">
                  <div>
                    <p className="font-mono-ui text-[10px] font-bold tracking-[.12em] text-[#d5b9ff]">DERIV ACCOUNT</p>
                    <p className="mt-1 text-xs text-[#8fa4b2]">Connected. Your balance and account mode are shown in the header.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { void disconnectDeriv(); }}
                    data-testid="button-deriv-logout"
                    className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[#8b3c48]/70 bg-[#3a1d28]/70 px-3 font-mono-ui text-[9px] font-bold tracking-wider text-[#ffb5bd] transition hover:border-[#d45d69] hover:bg-[#51242f]"
                  >
                    <LogIn size={13} className="rotate-180" /> LOG OUT
                  </button>
                </section>
              )}
              <label className="block space-y-2">
                <span className="block font-mono-ui text-[10px] font-bold tracking-[.12em] text-[#82dce5]">THEME</span>
                <select
                  value={settingsDraft.theme}
                  onChange={(event) => {
                    const theme = event.target.value;
                    if (theme === 'arctic' || theme === 'nebula' || theme === 'solar' || theme === 'biolume' || theme === 'lunar') {
                      setSettingsDraft((current) => ({ ...current, theme }));
                    }
                  }}
                  data-testid="select-workspace-theme"
                  className="w-full rounded-lg border border-[#285264] bg-[#0b202c] px-3 py-2.5 text-sm text-[#e1f3f5] outline-none focus:border-[#3dd5e3]"
                >
                  <option value="arctic">Arctic Glass · Ice blue and silver</option>
                  <option value="nebula">Nebula Drift · Cosmic violet and starlight</option>
                  <option value="solar">Solar Flare · Molten gold and crimson</option>
                  <option value="biolume">Biolume · Electric jade and ultraviolet</option>
                  <option value="lunar">Lunar Chrome · Moonstone and aurora</option>
                </select>
              </label>

            </div>

            <DialogFooter className="gap-2 sm:flex-row">
              <button type="button" onClick={() => setSettingsOpen(false)} data-testid="button-cancel-settings" className="rounded-lg border border-[#29404d] bg-[#101d27] px-4 py-2 text-xs font-bold text-[#aebec8] transition hover:border-[#527181]">
                CANCEL
              </button>
              <button type="button" onClick={saveSettings} data-testid="button-save-settings" className="rounded-lg border border-[#1e9e9c] bg-gradient-to-r from-[#087b83] to-[#136a91] px-4 py-2 text-xs font-extrabold tracking-wide text-white shadow-[0_4px_16px_rgba(24,184,190,.16)] transition hover:brightness-110">
                SAVE SETTINGS
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <DashboardView>
        <div id="workspace" className="scroll-mt-4">
        <div className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,2.2fr)_minmax(360px,1fr)] 2xl:grid-cols-[minmax(0,2.2fr)_minmax(420px,1fr)]">
        <div id="market-analysis" className="order-1 min-w-0 scroll-mt-4">
        <section className="vibrant-frame scanline relative overflow-hidden rounded-[15px] border border-[#20c9dc] bg-[#06111d] p-3 sm:p-4">
          <div className="ambient-orb ambient-orb-a pointer-events-none absolute right-[-60px] top-[-110px] h-64 w-64 rounded-full bg-[#10bfc3]/[.06] blur-[70px]" />
          <div className="ambient-orb ambient-orb-b pointer-events-none absolute bottom-[13%] left-[-120px] h-64 w-64 rounded-full bg-[#a344ff]/[.08] blur-[75px]" />
          <div className="relative z-[1]">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="flex items-center gap-2 font-display text-[25px] font-bold leading-none tracking-[.065em] text-[#eef1ee] sm:text-[30px]"><BarChart3 className="shrink-0 text-[#20d7ed]" size={27} /> CYCLE <span className="gradient-heading">INSPECTOR</span></h1>
              </div>
              <button type="button" onClick={reconnectFeed} data-testid="button-reconnect-feed" aria-label="Reconnect live market feed" title="Reconnect live market feed" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[#20697a] bg-[#102b39] text-[#66c9e2] transition hover:border-[#42a6bd] hover:text-[#a6edf0]">
                <RefreshCw size={14} />
              </button>
            </div>

            <div className="mb-4 grid gap-2 sm:grid-cols-[1.08fr_1fr]">
              <label className="market-picker flex min-w-0 items-center gap-2 rounded-lg border border-[#23696b]/70 bg-[#10262b] px-3 py-2.5">
                <Radio size={15} className="shrink-0 text-[#45d6d0]" />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono-ui text-[8px] tracking-[.13em] text-[#7da4a6]">SELECT LIVE MARKET</span>
                  <select value={marketSymbol} onChange={(event) => selectMarket(event.target.value)} data-testid="select-market" aria-label="Select live market" className="mt-1 w-full appearance-none bg-transparent pr-5 text-[12px] font-bold text-[#dff8f5] outline-none">
                    {markets.map((item) => <option key={item.symbol} value={item.symbol} className="bg-[#101a22]">{item.label}</option>)}
                  </select>
                </span>
                <ChevronDown size={14} className="shrink-0 text-[#6aa4a4]" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { const next = !autoScan; setAppPreferences((previous) => ({ ...previous, autoScan: next })); recordActivity(`Auto-scan ${next ? 'enabled' : 'paused'}`, 'Local interface toggle only; no automatic analysis is running.', next ? 'green' : 'gold'); }} aria-pressed={autoScan} data-testid="toggle-auto-scan" className={`button-auto col-span-2 flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-[10px] font-extrabold tracking-[.04em] transition ${autoScan ? 'border-[#28777a] bg-[#10383a] text-[#64dfd8]' : 'border-[#394654] bg-[#19222b] text-[#aab6c0]'}`}>
                  <span className={`relative h-[14px] w-[25px] rounded-full transition ${autoScan ? 'bg-[#19aaa9]' : 'bg-[#43505b]'}`}><span className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-[#e5f7f3] transition-transform ${autoScan ? 'translate-x-[13px]' : 'translate-x-[2px]'}`} /></span>
                  AUTO-SCAN <span className="font-mono-ui text-[9px]">{autoScan ? 'ON' : 'OFF'}</span>
                </button>
                <a href="#scanner-section" onClick={() => recordActivity('Scanner opened', 'Jumped to the live digit contract scanner.', 'violet')} data-testid="button-open-scanner" className="button-cycle flex items-center justify-center gap-2 rounded-lg border border-[#20697a] bg-[#102b39] px-2 py-2.5 text-[10px] font-bold tracking-[.04em] text-[#66c9e2] transition hover:border-[#42a6bd]"><Signal size={13} /> SCANNER</a>
                <button type="button" onClick={() => setNotice('Entry section is informational only — no trading actions are available.')} data-testid="button-entry-info" className="button-entry flex items-center justify-center gap-2 rounded-lg border border-[#167d79] bg-[#0e4140] px-2 py-2.5 text-[10px] font-bold tracking-[.04em] text-[#73e5d9] transition hover:border-[#32b9ae]"><CircleHelp size={13} /> ENTRY INFO</button>
              </div>
            </div>

            <div className="min-w-0">
              <div className="space-y-3 min-w-0">
                <section className="analysis-card card-cyan rounded-xl border border-[#9a7938] bg-[#071620]/95 p-3 sm:p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2"><div className="grid h-7 w-7 place-items-center rounded-md bg-[#3a301c] text-[#d7b760]"><Activity size={14} /></div><h2 className="text-[11px] font-extrabold tracking-[.1em] text-[#e3e8e6]">CANONICAL SCAN CYCLE</h2></div>
                    <span className={`rounded-md border px-2.5 py-1.5 font-mono-ui text-[9px] ${feedStatus === 'live' ? 'border-[#1d7577]/60 bg-[#0d3338]/50 text-[#6de4dc]' : 'border-[#805d26]/60 bg-[#382b13]/35 text-[#d7b966]'}`}>{feedStatusLabel}</span>
                  </div>
                  <div data-testid="digit-distribution" aria-label="Live digit distribution based on a rolling 1,000-tick window" className="rounded-lg border border-[#087b78] bg-[#031c21] p-3 sm:p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-[9px] font-bold text-[#dce8e4] sm:text-[10px]">{market.label}</h3>
                      </div>
                      <div className="shrink-0 rounded-md border border-[#17483b] bg-[#021810] px-3 py-1.5 text-right" aria-live="polite">
                        <span className="block font-mono-ui text-[7px] tracking-wider text-[#829b91]">LIVE PRICE</span>
                        <strong data-testid="text-live-price" className="block font-display text-base font-bold leading-tight text-[#00c6be] sm:text-lg">{liveMarketData.price ?? '--'}</strong>
                      </div>
                    </div>
                    {feedError && <p role="alert" data-testid="text-feed-error" className="mb-3 rounded border border-[#7f3434]/60 bg-[#381c20]/70 px-2 py-1.5 text-[9px] text-[#ffaaaa]">{feedError}</p>}
                    <ul data-testid="digit-grid" className="grid grid-cols-5 gap-x-2 gap-y-5 sm:gap-x-5 sm:gap-y-7">
                      {liveMarketData.digitCounts.map((ticks, digit) => {
                        const percentage = (ticks / TICK_WINDOW_SIZE) * 100;
                        const rank = digitRankByDigit.get(digit);
                        const tileStyle = rank === 'highest'
                          ? 'border-[#0bbd8c] bg-[#10b981] text-white shadow-[0_8px_24px_rgba(16,185,129,.2)]'
                          : rank === 'second-highest'
                            ? 'border-[#2759a7] bg-[#1d4ed8] text-white'
                            : rank === 'second-lowest'
                              ? 'border-[#facc15] bg-[#facc15] text-[#111827] shadow-[0_8px_24px_rgba(250,204,21,.2)]'
                              : rank === 'lowest'
                                ? 'border-[#f04444] bg-[#ef4444] text-white shadow-[0_8px_24px_rgba(239,68,68,.2)]'
                                : 'border-[#344653] bg-[#17232d] text-[#e0e8e4]';
                        const percentageStyle = rank === 'highest'
                          ? 'text-[#10d5a0]'
                          : rank === 'second-highest'
                            ? 'text-[#4d8cf6]'
                            : rank === 'second-lowest'
                              ? 'text-[#facc15]'
                              : rank === 'lowest'
                                ? 'text-[#ff5555]'
                                : 'text-[#a3b0b8]';
                        const isLatestTick = liveMarketData.lastDigit === digit;

                        return (
                          <li key={digit} data-testid={`digit-tile-${digit}`} data-rank={rank} aria-current={isLatestTick ? 'true' : undefined} aria-label={`Digit ${digit}: ${percentage.toFixed(1)} percent from ${ticks} live ticks${isLatestTick ? ', latest tick' : ''}`} className="min-w-0 text-center">
                            <div className="relative">
                              <div className={`grid aspect-square w-full place-items-center rounded-[12px] border text-2xl font-bold transition-colors duration-300 sm:rounded-[14px] sm:text-3xl ${tileStyle}`}>{digit}</div>
                              {isLatestTick && (
                                <span data-testid="latest-digit-pointer" aria-label={`Latest tick pointer: digit ${digit}`} className="pointer-events-none absolute -top-5 left-1/2 z-10 -translate-x-1/2 animate-bounce text-[#f4d36a] drop-shadow-[0_1px_4px_rgba(0,0,0,.9)]">
                                  <span className="block text-lg leading-none">▼</span>
                                </span>
                              )}
                            </div>
                            <span className={`mt-1.5 block font-mono-ui text-[8px] font-bold tracking-wide sm:mt-2 sm:text-[10px] ${percentageStyle}`}>{percentage.toFixed(1)}%</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div className="mt-3 rounded-lg border border-[#087b78] bg-[#031c21] p-3" data-testid="digit-key-insights">
                    <div className="mb-2 flex items-center gap-2">
                      <BarChart3 size={13} className="text-[#f6cf31]" />
                      <h3 className="font-mono-ui text-[9px] font-bold tracking-[.12em] text-[#f6cf31]">KEY INSIGHTS</h3>
                    </div>
                    {liveMarketData.tickCount > 0 ? (
                      <div className="space-y-2.5">
                        <div className="flex items-start gap-2 text-[10px] sm:text-[12px]">
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full border-2 border-[#42cbe4]" />
                          <p className="text-[#dce6ef]">Most frequent digits: <strong className="text-[#f6cf31]">
                            {mostFrequentDigits.map(({ digit, count }) => (
                              <span key={digit}>{digit}{digit !== mostFrequentDigits.at(-1)?.digit ? ', ' : ''}</span>
                            ))}
                          </strong></p>
                        </div>
                        <div className="flex items-start gap-2 text-[10px] sm:text-[12px]">
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full border-2 border-[#42cbe4]" />
                          <p className="text-[#dce6ef]">Least frequent: <strong className="text-[#f66c88]">{rankedDigits.filter(({ count }) => count === (leastFrequentDigit?.count ?? 0)).map(({ digit }) => digit).join(', ')}</strong> <span className="text-[#93a7b3]">(observed window)</span></p>
                        </div>
                        <div className="flex items-start gap-2 text-[10px] sm:text-[12px]">
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full border-2 border-[#42cbe4]" />
                          <p className="text-[#dce6ef]">Sample: <strong className="text-[#39d5e8]">{liveMarketData.tickCount.toLocaleString()}</strong> / {TICK_WINDOW_SIZE} ticks</p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-[10px] text-[#82939a]">Waiting for live ticks to summarize the sample.</p>
                    )}
                  </div>
                </section>

                <section data-testid="prediction-outcome-history" aria-label="Scanned prediction outcome history" className="rounded-xl border border-[#19aeb7] bg-gradient-to-br from-[#0a3038] via-[#09232d] to-[#211b12] p-3 shadow-[0_0_24px_rgba(25,190,190,.16)] sm:p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#28727a]/70 pb-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <div>
                        <h3 className="font-mono-ui text-[12px] font-extrabold tracking-[.08em] text-[#75f0e2] sm:text-sm">PREDICTION TRACKER</h3>
                        <p className="mt-1 text-[9px] text-[#a6c4c5]">Each signal is tracked on its own.</p>
                      </div>
                      <span className="rounded-full border border-[#28727a] bg-[#07353b] px-2.5 py-1 font-mono-ui text-[8px] font-bold tracking-wide text-[#9bd9dc]">
                        {predictionOutcomes.filter((outcome) => outcome.status === 'tracking').length} LIVE
                        <span className="mx-1.5 text-[#507980]">·</span>
                        {predictionOutcomes.length} TOTAL
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={resetPredictionOutcomes}
                        disabled={predictionOutcomes.length === 0}
                        data-testid="button-reset-prediction-results"
                        className="rounded-md border border-[#9a6560] bg-[#3a2025]/80 px-2.5 py-1.5 font-mono-ui text-[8px] font-bold tracking-wide text-[#ffc0a8] transition hover:border-[#ff8c77] hover:bg-[#55272b] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        RESET
                      </button>
                    </div>
                  </div>
                  {recentPredictionOutcomes.length > 0 ? (
                    <ol data-testid="market-contract-performance" className="space-y-2.5">
                      {recentPredictionOutcomes.map((outcome, index) => {
                        const hitRate = outcome.observedTicks > 0
                          ? `${((outcome.wins / outcome.observedTicks) * 100).toFixed(1)}%`
                          : '--';
                        const contractLabel = {
                          'match-digit': 'MATCHES',
                          differ: 'DIFFERS',
                          over: 'OVER',
                          under: 'UNDER',
                          'even-odd': 'EVEN / ODD',
                        }[outcome.contractType];
                        const statusLabel = outcome.status === 'tracking'
                          ? 'TRACKING'
                          : outcome.status === 'replaced'
                            ? 'ENDED BY NEW SCAN'
                            : outcome.status === 'interrupted'
                              ? 'INTERRUPTED · PARTIAL'
                              : 'COMPLETE';
                        const secondsRemaining = outcome.status === 'tracking'
                          ? Math.max(0, Math.ceil((outcome.expiresAt - performanceClock) / 1000))
                          : 0;
                        const awaitingMatchSettlement = outcome.targetTickOffset > 0
                          && outcome.observedTicks === 0;
                        const trackingProgress = Math.min(
                          100,
                          awaitingMatchSettlement
                            ? (outcome.pendingTicks / outcome.targetTickOffset) * 100
                            : Math.max(0, ((performanceClock - outcome.startedAt)
                              / (outcome.expiresAt - outcome.startedAt)) * 100),
                        );

                        return (
                          <li
                            key={outcome.id}
                            data-testid={`prediction-outcome-${outcome.id}`}
                            data-signal-order={index + 1}
                            className={`min-w-0 overflow-hidden rounded-xl border bg-[#091d25] shadow-[inset_0_1px_0_rgba(115,240,226,.06)] ${index === 0 ? 'border-[#35c9ba]' : 'border-[#23777c]/70'}`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                              <div className="flex min-w-0 items-center gap-3">
                                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border font-display text-[18px] font-extrabold ${outcome.status === 'tracking' ? 'border-[#4b8c81] bg-[#103a34] text-[#79f0c4]' : 'border-[#34525a] bg-[#10232b] text-[#a0c4c6]'}`}>
                                  {outcome.digit ?? (outcome.contractType === 'even-odd' ? outcome.signalLabel.slice(0, 1) : '•')}
                                </span>
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <h4 className="break-words font-semibold text-[12px] text-[#f0fffc]">{outcome.signalLabel}</h4>
                                    {index === 0 && <span className="rounded bg-[#103f3b] px-1.5 py-0.5 font-mono-ui text-[7px] font-bold tracking-wide text-[#8af0dc]">LATEST</span>}
                                  </div>
                                  <p className="mt-0.5 truncate text-[10px] text-[#b3ced0]">{outcome.marketLabel} · {contractLabel}</p>
                                  <p className="mt-0.5 font-mono-ui text-[8px] text-[#73979c]">
                                    {new Date(outcome.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                    {outcome.targetTickOffset > 0 ? ` · checks tick ${outcome.targetTickOffset}` : ''}
                                  </p>
                                </div>
                              </div>
                              <div className="min-w-[150px] text-left sm:text-right">
                                <span
                                  data-testid={`prediction-status-${outcome.id}`}
                                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-ui text-[9px] font-extrabold tracking-wide ${outcome.status === 'tracking' ? 'border-[#a98029] bg-[#392b0d] text-[#ffdb67]' : outcome.status === 'interrupted' ? 'border-[#a84a5f] bg-[#411e2a] text-[#ff9caf]' : 'border-[#34525a] bg-[#0b2028] text-[#a0c4c6]'}`}
                                >
                                  {outcome.status === 'tracking' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#ffcf45]" />}
                                  {outcome.status === 'tracking'
                                    ? awaitingMatchSettlement
                                      ? 'WAITING FOR RESULT'
                                      : `TRACKING · ${secondsRemaining}s`
                                    : outcome.status === 'complete'
                                      ? '30s COMPLETE'
                                      : statusLabel}
                                </span>
                                <p className="mt-1 text-[10px] font-semibold text-[#d9efed]">
                                  {awaitingMatchSettlement
                                    ? `Waiting for tick ${outcome.targetTickOffset} · ${outcome.pendingTicks}/${outcome.targetTickOffset} ticks`
                                    : `${outcome.wins} wins · ${outcome.losses} losses`}
                                </p>
                              </div>
                            </div>
                            {outcome.status === 'tracking' && (
                              <div
                                role="progressbar"
                                aria-label={awaitingMatchSettlement
                                  ? `${outcome.pendingTicks} of ${outcome.targetTickOffset} execution-delay ticks observed`
                                  : `${outcome.observedTicks} live ticks tracked, ${secondsRemaining} seconds remaining`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(trackingProgress)}
                                className="mx-3 mb-2 h-1.5 overflow-hidden rounded-full bg-[#173039]"
                              >
                                <div
                                  data-testid={`prediction-progress-${outcome.id}`}
                                  className="h-full rounded-full bg-gradient-to-r from-[#19b899] via-[#65e8c2] to-[#ffcf45] transition-[width] duration-300"
                                  style={{ width: `${trackingProgress}%` }}
                                />
                              </div>
                            )}
                            {outcome.status === 'tracking' && (
                              <p
                                data-testid={`prediction-live-count-${outcome.id}`}
                                aria-live="polite"
                                className="sr-only"
                              >
                                {awaitingMatchSettlement
                                  ? `Waiting for result. ${outcome.pendingTicks} of ${outcome.targetTickOffset} ticks received.`
                                  : `${outcome.wins} wins, ${outcome.losses} losses from ${outcome.observedTicks} ticks.`}
                              </p>
                            )}
                            <details className="border-t border-[#23777c]/40">
                              <summary className="cursor-pointer px-3 py-2 text-[9px] font-semibold text-[#79c9c5] transition hover:bg-[#102a30] hover:text-[#b4f7ed]">
                                More details
                              </summary>
                              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 pb-3 pt-1 text-[9px] sm:grid-cols-4">
                                <div><dt className="text-[#82b2b5]">Live accuracy</dt><dd className="font-bold text-[#66f0c0]">{hitRate}</dd></div>
                                <div><dt className="text-[#82b2b5]">Backtest</dt><dd className="text-[#ecf6f7]">{outcome.backtestPredictions > 0 ? `${(outcome.backtestAccuracy * 100).toFixed(1)}% (${outcome.backtestHits}/${outcome.backtestPredictions})` : 'Not enough data'}</dd></div>
                                <div><dt className="text-[#82b2b5]">Brier score</dt><dd className="text-[#d3c7ff]">{outcome.observedTicks > 0 ? (outcome.squaredProbabilityError / outcome.observedTicks).toFixed(3) : 'Not available yet'}</dd></div>
                                <div><dt className="text-[#82b2b5]">Expected value</dt><dd className="font-bold text-[#ffd46e]">{outcome.expectedValue === null ? 'Not available' : outcome.expectedValue.toFixed(2)}</dd></div>
                                <div className="col-span-2 font-mono-ui text-[8px] text-[#9aaec2] sm:col-span-4">
                                  Confidence range: {(outcome.wilsonLowerBound * 100).toFixed(1)}%–{(outcome.wilsonUpperBound * 100).toFixed(1)}% · Baseline: {(outcome.baselineRate * 100).toFixed(1)}%
                                </div>
                              </dl>
                            </details>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="rounded-lg border border-dashed border-[#28727a] bg-[#071c27]/80 px-3 py-4 text-center text-[9px] text-[#b3d3d5]">No prediction results yet.</p>
                  )}
                  <p className="mt-2 text-[8px] leading-relaxed text-[#829ea1]">Results are recorded from live ticks. They describe past outcomes, not a guarantee of future results.</p>
                </section>

                <section className="analysis-card card-gold rounded-xl border border-[#30404c] bg-[#101b24]/90 p-3 sm:p-4">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <h2 data-testid="text-selected-market" className="font-display text-[21px] font-bold leading-none tracking-[.06em] text-[#edf2f0] sm:text-[24px]">{market.label.toUpperCase()}</h2>
                    </div>
                    <div className={`flex items-center gap-1 rounded-full border px-2 py-1 font-mono-ui text-[8px] tracking-wider ${feedStatus === 'live' ? 'border-[#398b70]/50 bg-[#12352d]/70 text-[#72d7aa]' : 'border-[#805d26]/60 bg-[#382b13]/35 text-[#d7b966]'}`}><Radio size={11} /> {feedStatusLabel}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="metric-card metric-confidence rounded-lg border border-[#276c89] bg-[#102a3b] p-3 shadow-[inset_0_0_24px_rgba(38,141,190,.08)]">
                      <div className="flex items-center justify-between gap-2"><span className="font-mono-ui text-[8px] tracking-[.13em] text-[#72b6d2]">LIVE LAST DIGIT</span><Gauge size={14} className="text-[#52bfe1]" /></div>
                      <div data-testid="text-live-last-digit" className="mt-2 font-display text-[31px] font-bold leading-none text-[#d9f5ff]">{liveMarketData.lastDigit ?? '--'}</div>
                    </div>
                    <div className="metric-card metric-sample rounded-lg border border-[#236d69] bg-[#103330] p-3 shadow-[inset_0_0_24px_rgba(25,193,164,.08)]">
                      <div className="flex items-center justify-between gap-2"><span className="font-mono-ui text-[8px] tracking-[.13em] text-[#75cbbd]">TICKS IN WINDOW</span><Activity size={14} className="text-[#48d1ba]" /></div>
                      <div data-testid="text-live-tick-count" className="mt-2 font-display text-[31px] font-bold leading-none text-[#d9fff1]">{liveMarketData.tickCount.toLocaleString()}</div>
                    </div>
                  </div>
                </section>
              </div>

            </div>

            <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#293944] pt-3">
              <p data-testid="status-data-disclaimer" className="flex items-center gap-1.5 text-[9px] text-[#82939a]"><ShieldCheck size={12} className="text-[#62c9ae]"/> Predictions are not guarantees or trading advice.</p>
              <button type="button" onClick={() => setNotice('Signals use adjusted walk-forward validation. Actual EV requires recorded proposal and payout data.')} data-testid="button-data-info" className="flex items-center gap-1.5 text-[9px] font-bold tracking-[.05em] text-[#73b8c3] transition hover:text-[#a6edf0]"><CircleHelp size={12} /> DATA ANALYSIS</button>
            </footer>
          </div>
        </section>
        </div>
        <section id="scanner-section" aria-label="Market scanner" className="order-2 min-w-0 scroll-mt-4">
          <MarketScannerDashboard
            markets={volatilityMarkets.map((item) => ({
              ...item,
              ticks: scannerTicksByMarket[item.symbol] ?? [],
              tickVersion: scannerTickVersionsByMarket[item.symbol] ?? 0,
            }))}
            feedStatus={scannerFeedStatus}
            feedError={scannerFeedError}
            onMarketSelect={selectMarket}
            onPredictionStart={startPredictionOutcome}
            onSoundAlert={playScannerSoundAlert}
          />
        </section>
        </div>
        </div>
        <section id="activity-log" className="mt-5 scroll-mt-4">
          <ActivityLogView entries={activityEntries} />
        </section>
        <section id="connection-log" className="mt-5 scroll-mt-4">
          <section className="analysis-card card-log rounded-xl border border-[#30404c] bg-[#101b24]/90 p-3 sm:p-4">
            <button type="button" onClick={() => setLogExpanded((value) => !value)} aria-expanded={logExpanded} data-testid="button-toggle-status-log" className="flex w-full items-center justify-between text-left">
              <span className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-md bg-[#173034] text-[#56d5cc]"><Cpu size={14} /></span><span><span className="block text-[11px] font-extrabold tracking-[.1em] text-[#e4e9e7]">CONNECTION &amp; LOG</span><span className="mt-0.5 block font-mono-ui text-[8px] tracking-wider text-[#789099]">PUBLIC TICK FEED · NO ACCOUNT LINK</span></span></span>
              <ChevronDown size={15} className={`text-[#82939a] transition-transform ${logExpanded ? 'rotate-180' : ''}`} />
            </button>
            {logExpanded && <div className="mt-3 space-y-2 border-t border-[#273842] pt-3 rise-in">
              <div data-testid="status-connection-preview" className="flex items-center justify-between gap-2 rounded-md bg-[#0c171d] px-2.5 py-2"><span className="flex items-center gap-2 text-[10px] text-[#a5b4bb]"><Wifi size={13} className="text-[#4dcbb9]" /> Deriv WebSocket</span><span className={`flex items-center gap-1 font-mono-ui text-[8px] ${feedStatus === 'live' ? 'text-[#6de4dc]' : 'text-[#dbb65a]'}`}><span className={`h-1.5 w-1.5 rounded-full ${feedStatus === 'live' ? 'bg-[#42d8d2]' : 'bg-[#d6ad51]'}`} /> {feedStatusLabel}</span></div>
              <div className="flex items-center justify-between gap-2 rounded-md bg-[#0c171d] px-2.5 py-2"><span className="flex items-center gap-2 text-[10px] text-[#a5b4bb]"><Signal size={13} className="text-[#58b8dc]" /> Bot synchronization</span><span className="font-mono-ui text-[8px] tracking-wider text-[#8a9aa1]">NOT CONNECTED</span></div>
              <div className="flex items-start gap-2 rounded-md border border-[#273842] bg-[#0c171d] px-2.5 py-2.5"><span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#43cdc2]" /><div className="min-w-0"><p data-testid="text-latest-log" className="truncate text-[10px] text-[#b8c8ce]">{lastAction}</p><p className="mt-1 font-mono-ui text-[8px] tracking-wider text-[#637780]">LOCAL UI EVENT · PUBLIC MARKET FEED</p></div><span className="ml-auto shrink-0 font-mono-ui text-[8px] text-[#62767d]">NOW</span></div>
              <p className="flex items-start gap-1.5 px-1 pt-0.5 text-[9px] leading-relaxed text-[#7d8f98]"><AlertTriangle size={11} className="mt-0.5 shrink-0 text-[#c4a754]" /> {feedError ?? (feedStatus === 'live' ? `Receiving live ${market.label} ticks. No trading account is connected.` : 'Connecting to the public Deriv tick feed. No trading account is connected.')}</p>
              <div className="flex items-center gap-1.5 border-t border-[#273842] px-1 pt-2 font-mono-ui text-[9px] text-[#7d8f98]">
                <span>Powered by</span>
                <a href="https://pulsefactor.space/" target="_blank" rel="noopener noreferrer" className="rounded px-1 py-0.5 font-bold tracking-wider text-[#71e2d6] transition hover:bg-[#103334] hover:text-[#a0fff0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71e2d6]">
                  PULSE-FACTOR
                </a>
              </div>
            </div>}
          </section>
        </section>
        <p className="mx-auto mt-3 max-w-4xl text-center font-mono-ui text-[8px] leading-relaxed tracking-[.08em] text-[#566872]">DERIV MARKET ANALYSIS CONSOLE <span className="mx-1 text-[#a98b4d]">/</span> PUBLIC LIVE DATA <span className="mx-1 text-[#a98b4d]">/</span> TRADING DISABLED</p>
        </DashboardView>
      </div>
    </main>
  );
}

function DashboardView({ children }: { children: ReactNode }) {
  return <div data-testid="view-dashboard" className="tab-view rise-in">{children}</div>;
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
