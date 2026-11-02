import { type ReactNode, useEffect, useRef, useState } from 'react';
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
  ChevronDown,
  CircleHelp,
  Cpu,
  Download,
  Gauge,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Signal,
  Wifi,
  X,
} from 'lucide-react';
import { ActivityLogView, type ActivityRecord } from './components/analysis/ActivityLogView';
import {
  DigitScannerView,
  isContractWin,
  type ContractType,
  type PredictionOutcomeStart,
} from './components/analysis/DigitScannerView';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

type WorkspaceTheme = 'ocean' | 'aurora' | 'ember' | 'cyberpunk' | 'obsidian';
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface WorkspaceSettings {
  theme: WorkspaceTheme;
  contractType: ContractType;
}

const SETTINGS_STORAGE_KEY = 'deriv-analysis-workspace-settings';
const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  theme: 'ocean',
  contractType: 'match-digit',
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

    const candidate = parsed as Partial<WorkspaceSettings>;
    return {
      theme: candidate.theme === 'aurora'
        || candidate.theme === 'ember'
        || candidate.theme === 'cyberpunk'
        || candidate.theme === 'obsidian'
        ? candidate.theme
        : 'ocean',
      contractType: candidate.contractType === 'differ'
        || candidate.contractType === 'under'
        || candidate.contractType === 'over'
        || candidate.contractType === 'even-odd'
        ? candidate.contractType
        : candidate.contractType === 'over-under'
          ? 'over'
          : 'match-digit',
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

interface LiveTick {
  price: string;
  digit: number;
}

interface ScannedMarketData extends MarketOption {
  ticks: LiveTick[];
}

type PredictionOutcomeRecord = PredictionOutcomeStart & {
  wins: number;
  losses: number;
  observedTicks: number;
  status: 'tracking' | 'complete' | 'replaced';
};

interface DerivFeedMessage {
  error?: { message?: string };
  req_id?: number;
  pip_size?: number;
  history?: { prices?: (string | number)[] };
  tick?: { quote?: string | number; symbol?: string; pip_size?: number };
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

function getQuoteDetails(quote: string | number, pipSize: number) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(quote));
  if (!match) {
    return null;
  }

  const decimals = Number.isInteger(pipSize) && pipSize >= 0 && pipSize <= 10
    ? pipSize
    : 2;
  const fraction = (match[3] ?? '').padEnd(decimals, '0');
  const price = `${match[1]}${match[2]}${fraction ? `.${fraction}` : ''}`;
  const lastDigit = Number(price.at(-1));

  return Number.isInteger(lastDigit) ? { price, lastDigit } : null;
}

function Home() {
  const [markets, setMarkets] = useState<MarketOption[]>(DEFAULT_MARKETS);
  const [marketSymbol, setMarketSymbol] = useState<string>(DEFAULT_MARKETS[0].symbol);
  const [autoScan, setAutoScan] = useState(true);
  const [notice, setNotice] = useState('');
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
  const [scannerFeedStatus, setScannerFeedStatus] = useState<FeedStatus>('connecting');
  const [scannerFeedError, setScannerFeedError] = useState<string | null>(null);
  const market = markets.find((item) => item.symbol === marketSymbol) ?? DEFAULT_MARKETS[0];
  const activitySequence = useRef(3);
  const tickHistoryByMarket = useRef(new Map<string, LiveTick[]>());
  const activeFeedMarket = useRef(marketSymbol);
  const activePredictionOutcomeRef = useRef<PredictionOutcomeRecord | null>(null);
  const predictionOutcomeTimeoutRef = useRef<number | undefined>(undefined);
  const [activityEntries, setActivityEntries] = useState<ActivityRecord[]>([
    { id: 2, time: 'READY', title: 'Connecting to live market feed', detail: 'Waiting for public Deriv tick data.', tone: 'blue' },
  ]);

  useEffect(() => {
    document.documentElement.dataset.workspaceTheme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
        .catch((error: unknown) => {
          console.error('Unable to register the ONE-MARKET offline app shell.', error);
        });
    }

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setIsAppInstalled(true);
      setInstallPromptEvent(null);
      setNotice('ONE-MARKET installed.');
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
    ].slice(0, 8));
  };

  const finishPredictionOutcome = (status: 'complete' | 'replaced') => {
    const outcome = activePredictionOutcomeRef.current;
    if (!outcome) {
      return;
    }

    if (predictionOutcomeTimeoutRef.current !== undefined) {
      window.clearTimeout(predictionOutcomeTimeoutRef.current);
      predictionOutcomeTimeoutRef.current = undefined;
    }
    publishPredictionOutcome({ ...outcome, status });
    activePredictionOutcomeRef.current = null;
  };

  const startPredictionOutcome = (prediction: PredictionOutcomeStart) => {
    finishPredictionOutcome('replaced');
    const outcome: PredictionOutcomeRecord = {
      ...prediction,
      wins: 0,
      losses: 0,
      observedTicks: 0,
      status: 'tracking',
    };
    activePredictionOutcomeRef.current = outcome;
    publishPredictionOutcome(outcome);
    predictionOutcomeTimeoutRef.current = window.setTimeout(() => {
      if (activePredictionOutcomeRef.current?.id === outcome.id) {
        finishPredictionOutcome('complete');
      }
    }, Math.max(0, prediction.expiresAt - Date.now()));
  };

  const resetPredictionOutcomes = () => {
    if (predictionOutcomeTimeoutRef.current !== undefined) {
      window.clearTimeout(predictionOutcomeTimeoutRef.current);
      predictionOutcomeTimeoutRef.current = undefined;
    }
    activePredictionOutcomeRef.current = null;
    setPredictionOutcomes([]);
  };

  useEffect(() => () => {
    if (predictionOutcomeTimeoutRef.current !== undefined) {
      window.clearTimeout(predictionOutcomeTimeoutRef.current);
    }
  }, []);

  const selectMarket = (symbol: string) => {
    const selectedMarket = markets.find((item) => item.symbol === symbol);
    if (!selectedMarket || selectedMarket.symbol === marketSymbol) {
      return;
    }

    setLiveMarketData(EMPTY_LIVE_MARKET_DATA);
    setMarketSymbol(selectedMarket.symbol);
    recordActivity('Live market changed', `Subscribing to ${selectedMarket.label}.`, 'cyan');
  };

  const installApp = async () => {
    if (!installPromptEvent) {
      setNotice('To install ONE-MARKET, open your browser menu and select Install app or Add to Home Screen.');
      return;
    }

    try {
      await installPromptEvent.prompt();
      const { outcome } = await installPromptEvent.userChoice;
      setInstallPromptEvent(null);
      if (outcome === 'accepted') {
        setNotice('ONE-MARKET is installing.');
      }
    } catch (error) {
      console.error('Unable to start ONE-MARKET installation.', error);
      setNotice('ONE-MARKET could not be installed. Try the install option in your browser menu.');
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
        currentSocket.send(JSON.stringify({
          ticks_history: marketSymbol,
          count: TICK_WINDOW_SIZE,
          end: 'latest',
          style: 'ticks',
          subscribe: 1,
        }));
        currentSocket.send(JSON.stringify({ active_symbols: 'full' }));
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
          pipSize = message.pip_size;
        }

        if (message.history?.prices) {
          const history = message.history.prices
            .map((quote) => getQuoteDetails(quote, pipSize))
            .filter((quote): quote is NonNullable<typeof quote> => quote !== null)
            .slice(-TICK_WINDOW_SIZE);
          ticks = history.map(({ price, lastDigit }) => ({ price, digit: lastDigit }));
          tickHistoryByMarket.current.set(marketSymbol, ticks);
          publishData();
          setFeedStatus('live');
          setFeedError(null);
          reconnectAttempt = 0;
          return;
        }

        if (message.tick?.quote !== undefined) {
          if (message.tick.pip_size !== undefined) {
            pipSize = message.tick.pip_size;
          }
          const quote = getQuoteDetails(message.tick.quote, pipSize);
          if (quote) {
            ticks = [...ticks, { price: quote.price, digit: quote.lastDigit }].slice(-TICK_WINDOW_SIZE);
            tickHistoryByMarket.current.set(marketSymbol, ticks);
            publishData();
            setFeedStatus('live');
            setFeedError(null);
            reconnectAttempt = 0;
          }
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
          setScannerFeedError(
            failedMarket
              ? `Could not scan ${failedMarket.label}: ${message.error.message || 'Deriv rejected its tick request.'}`
              : message.error.message || 'Deriv rejected a scanner tick request.',
          );
          return;
        }

        const symbol = message.tick?.symbol
          ?? requestSymbol
          ?? (typeof message.echo_req?.ticks_history === 'string' ? message.echo_req.ticks_history : undefined);
        if (!symbol || !volatilityMarkets.some((item) => item.symbol === symbol)) {
          return;
        }

        if (message.pip_size !== undefined) {
          pipSizeBySymbol.set(symbol, message.pip_size);
        }
        if (message.tick?.pip_size !== undefined) {
          pipSizeBySymbol.set(symbol, message.tick.pip_size);
        }
        const pipSize = pipSizeBySymbol.get(symbol) ?? 2;

        if (message.history?.prices) {
          const history = message.history.prices
            .map((quote) => getQuoteDetails(quote, pipSize))
            .filter((quote): quote is NonNullable<typeof quote> => quote !== null)
            .slice(-TICK_WINDOW_SIZE)
            .map(({ price, lastDigit }) => ({ price, digit: lastDigit }));
          ticksBySymbol.set(symbol, history);
          setScannerTicksByMarket((current) => ({ ...current, [symbol]: history }));
          setScannerFeedStatus('live');
          setScannerFeedError(null);
          reconnectAttempt = 0;
          return;
        }

        if (message.tick?.quote !== undefined) {
          const quote = getQuoteDetails(message.tick.quote, pipSize);
          if (quote) {
            const predictionOutcome = activePredictionOutcomeRef.current;
            if (predictionOutcome?.marketSymbol === symbol) {
              if (Date.now() >= predictionOutcome.expiresAt) {
                finishPredictionOutcome('complete');
              } else {
                const won = isContractWin(
                  predictionOutcome.contractType,
                  predictionOutcome.signalKey,
                  predictionOutcome.digit,
                  quote.lastDigit,
                );
                const updatedOutcome: PredictionOutcomeRecord = {
                  ...predictionOutcome,
                  wins: predictionOutcome.wins + Number(won),
                  losses: predictionOutcome.losses + Number(!won),
                  observedTicks: predictionOutcome.observedTicks + 1,
                };
                activePredictionOutcomeRef.current = updatedOutcome;
                publishPredictionOutcome(updatedOutcome);
              }
            }

            const ticks = [...(ticksBySymbol.get(symbol) ?? []), { price: quote.price, digit: quote.lastDigit }]
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
    recordActivity('Workspace settings saved', `Theme: ${settingsDraft.theme}; preferred contract: ${settingsDraft.contractType}.`);
    setNotice(`Settings saved. The next scan will use ${settingsDraft.contractType.replace('-', ' ').toUpperCase()}. No contract is purchased or traded.`);
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
  return (
    <main className="dashboard-backdrop min-h-[100dvh] px-3 pb-8 pt-3 text-[#dce6ef] sm:px-3 sm:pt-4">
      <div className="mx-auto max-w-[1440px]">
        <header className="topbar mb-4 flex items-center justify-between gap-3 border-b border-[#263441] pb-3 sm:mb-6 sm:pb-4">
          <div className="flex items-center gap-3">
            <div className="brand-mark grid h-10 w-10 place-items-center rounded-xl border border-[#b89a57]/50 bg-[#17232a] text-[#d3b66e] shadow-[inset_0_0_16px_rgba(202,172,97,.08)]">
              <Activity size={20} strokeWidth={1.8} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display text-[22px] font-bold leading-none tracking-[.09em] text-[#f2f0e9]">ONE-MARKET</span>
              </div>
              <p className="mt-1 font-mono-ui text-[8px] tracking-[.12em] text-[#7f929e]">LIVE MARKET ANALYSIS</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isAppInstalled && (
              <button type="button" onClick={installApp} data-testid="button-install-app" className="flex h-9 items-center gap-1.5 rounded-lg border border-[#1c7778]/60 bg-[#103334]/70 px-2.5 font-mono-ui text-[8px] font-bold tracking-wider text-[#71e2d6] transition hover:border-[#54d8d6] hover:bg-[#164348] sm:px-3">
                <Download size={13} /> INSTALL APP
              </button>
            )}
            <div data-testid="status-market-feed" aria-live="polite" className="preview-badge flex items-center gap-2 rounded-full border border-[#1d7577]/55 bg-[#0d3338]/50 px-3 py-1.5">
              <span className={`pulse-dot h-1.5 w-1.5 rounded-full ${feedStatus === 'live' ? 'bg-[#42d8d2]' : feedStatus === 'error' ? 'bg-[#ef4444]' : 'bg-[#d6ad51]'}`} />
              <span className="font-mono-ui text-[10px] tracking-[.12em] text-[#6de4dc]">{feedStatusLabel}</span>
            </div>
            <button type="button" onClick={() => setNotice('Notifications are disabled in this preview.')} aria-label="Notifications" data-testid="button-notifications" className="grid h-9 w-9 place-items-center rounded-lg border border-[#263441] bg-[#101a22] text-[#a5b2bc] transition hover:border-[#447985] hover:text-[#54d8d6]">
              <Bell size={16} />
            </button>
            <button type="button" onClick={() => { setSettingsDraft(settings); setSettingsOpen(true); }} aria-label="Settings" data-testid="button-settings" className="grid h-9 w-9 place-items-center rounded-lg border border-[#263441] bg-[#101a22] text-[#a5b2bc] transition hover:border-[#447985] hover:text-[#54d8d6]">
              <Settings2 size={16} />
            </button>
          </div>
        </header>

        <nav className="section-nav mb-4 flex items-center gap-2 border-b border-[#263441] pb-2 sm:mb-5" aria-label="Main navigation">
          <a href="#workspace" data-testid="tab-workspace" aria-current="page" className="nav-current relative inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#1c7778]/60 bg-[#103334]/70 px-3 py-2 font-mono-ui text-[9px] font-bold tracking-wider text-[#71e2d6] transition hover:border-[#54d8d6] hover:bg-[#164348]">
            <Activity size={13} /> WORKSPACE
          </a>
        </nav>

        {notice && <div role="status" data-testid="status-notice" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-[#1f7374]/50 bg-[#0e3034] px-3 py-2.5 text-[11px] text-[#9be7df] rise-in"><span>{notice}</span><button type="button" onClick={() => setNotice('')} data-testid="button-dismiss-notice" aria-label="Dismiss notice"><X size={14} /></button></div>}

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="w-[calc(100%-1.5rem)] max-w-md border-[#246778] bg-[#07141f] p-5 text-[#dce6ef] shadow-[0_0_40px_rgba(16,190,205,.16)] sm:p-6">
            <DialogHeader className="pr-7 text-left">
              <DialogTitle className="flex items-center gap-2 font-display text-2xl tracking-wide text-[#eff4ff]">
                <Settings2 size={20} className="text-[#43d6e5]" /> WORKSPACE SETTINGS
              </DialogTitle>
              <DialogDescription className="text-xs leading-relaxed text-[#8fa4b2]">
                Choose the workspace appearance and the contract type you want to configure.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              <label className="block space-y-2">
                <span className="block font-mono-ui text-[10px] font-bold tracking-[.12em] text-[#82dce5]">THEME</span>
                <select
                  value={settingsDraft.theme}
                  onChange={(event) => {
                    const theme = event.target.value;
                    if (theme === 'ocean' || theme === 'aurora' || theme === 'ember' || theme === 'cyberpunk' || theme === 'obsidian') {
                      setSettingsDraft((current) => ({ ...current, theme }));
                    }
                  }}
                  data-testid="select-workspace-theme"
                  className="w-full rounded-lg border border-[#285264] bg-[#0b202c] px-3 py-2.5 text-sm text-[#e1f3f5] outline-none focus:border-[#3dd5e3]"
                >
                  <option value="ocean">Ocean · Cyan and teal</option>
                  <option value="aurora">Aurora · Violet and blue</option>
                  <option value="ember">Ember · Gold and coral</option>
                  <option value="cyberpunk">Cyberpunk · Neon magenta and electric blue</option>
                  <option value="obsidian">Obsidian · Graphite and platinum</option>
                </select>
              </label>

              <label className="block space-y-2">
                <span className="block font-mono-ui text-[10px] font-bold tracking-[.12em] text-[#82dce5]">SCANNER CONTRACT TYPE</span>
                <select
                  value={settingsDraft.contractType}
                  onChange={(event) => {
                    const contractType = event.target.value;
                    if (contractType === 'match-digit' || contractType === 'differ' || contractType === 'over' || contractType === 'under' || contractType === 'even-odd') {
                      setSettingsDraft((current) => ({ ...current, contractType }));
                    }
                  }}
                  data-testid="select-contract-type"
                  className="w-full rounded-lg border border-[#285264] bg-[#0b202c] px-3 py-2.5 text-sm text-[#e1f3f5] outline-none focus:border-[#3dd5e3]"
                >
                  <option value="match-digit">Matches · current scanner</option>
                  <option value="differ">Differs</option>
                  <option value="over">Over</option>
                  <option value="under">Under</option>
                  <option value="even-odd">Even / Odd</option>
                </select>
                <span className="block text-[10px] leading-relaxed text-[#8195a3]">
                  The next scan applies this contract’s win condition and walk-forward test. Over and Under are scanned separately using their configured barriers. Analysis only; this does not place trades.
                </span>
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
        <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,2.2fr)_minmax(260px,1fr)]">
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
                <button type="button" onClick={() => { const next = !autoScan; setAutoScan(next); recordActivity(`Auto-scan ${next ? 'enabled' : 'paused'}`, 'Local interface toggle only; no automatic analysis is running.', next ? 'green' : 'gold'); }} aria-pressed={autoScan} data-testid="toggle-auto-scan" className={`button-auto col-span-2 flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-[10px] font-extrabold tracking-[.04em] transition ${autoScan ? 'border-[#28777a] bg-[#10383a] text-[#64dfd8]' : 'border-[#394654] bg-[#19222b] text-[#aab6c0]'}`}>
                  <span className={`relative h-[14px] w-[25px] rounded-full transition ${autoScan ? 'bg-[#19aaa9]' : 'bg-[#43505b]'}`}><span className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-[#e5f7f3] transition-transform ${autoScan ? 'translate-x-[13px]' : 'translate-x-[2px]'}`} /></span>
                  AUTO-SCAN <span className="font-mono-ui text-[9px]">{autoScan ? 'ON' : 'OFF'}</span>
                </button>
                <a href="#scanner-section" onClick={() => recordActivity('Scanner opened', 'Jumped to the live digit contract scanner.', 'violet')} data-testid="button-open-scanner" className="button-cycle flex items-center justify-center gap-2 rounded-lg border border-[#20697a] bg-[#102b39] px-2 py-2.5 text-[10px] font-bold tracking-[.04em] text-[#66c9e2] transition hover:border-[#42a6bd]"><Signal size={13} /> SCANNER</a>
                <button type="button" onClick={() => setNotice('Entry section is informational only — no trading actions are available.')} data-testid="button-entry-info" className="button-entry flex items-center justify-center gap-2 rounded-lg border border-[#167d79] bg-[#0e4140] px-2 py-2.5 text-[10px] font-bold tracking-[.04em] text-[#73e5d9] transition hover:border-[#32b9ae]"><CircleHelp size={13} /> ENTRY INFO</button>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1.22fr_.78fr]">
              <div className="space-y-3">
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

                <section data-testid="prediction-outcome-history" aria-label="Scanned prediction outcome history" className="rounded-lg border border-[#087b78] bg-[#031c21] p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="font-mono-ui text-[9px] font-bold tracking-[.12em] text-[#f6cf31]">DATA ANALYSIS</h3>
                    <div className="flex items-center gap-2">
                      <span className="font-mono-ui text-[7px] text-[#829b91]">30-SECOND LIVE OUTCOMES</span>
                      <button
                        type="button"
                        onClick={resetPredictionOutcomes}
                        disabled={predictionOutcomes.length === 0}
                        data-testid="button-reset-prediction-results"
                        className="rounded border border-[#526171] px-2 py-1 font-mono-ui text-[7px] font-bold text-[#aebdca] transition hover:border-[#d98989] hover:text-[#ffaaaa] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        RESET
                      </button>
                    </div>
                  </div>
                  {predictionOutcomes.length > 0 ? (
                    <ol className="space-y-1.5">
                      {predictionOutcomes.map((outcome) => {
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
                        return (
                          <li key={outcome.id} data-testid={`prediction-outcome-${outcome.id}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-[#17483b] bg-[#061a1b] px-2.5 py-2">
                            <span className="min-w-0 flex-1">
                              <strong className="block truncate text-[9px] text-[#dce8e4]">{outcome.marketLabel} · {outcome.signalLabel}</strong>
                              <span className="font-mono-ui text-[7px] text-[#829b91]">{outcome.marketSymbol} · {contractLabel}</span>
                            </span>
                            <span className="text-right">
                              <strong className="block font-mono-ui text-[9px] text-[#6de4dc]">{outcome.wins}/{outcome.observedTicks} · {hitRate}</strong>
                              <span className={`font-mono-ui text-[7px] ${outcome.status === 'tracking' ? 'text-[#e0c365]' : 'text-[#829b91]'}`}>
                                {outcome.status === 'tracking' ? 'TRACKING' : outcome.status === 'replaced' ? 'ENDED BY NEW SCAN' : 'COMPLETE'}
                                {outcome.observedTicks > 0 ? ` · ${outcome.losses} misses` : ''}
                              </span>
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="text-[9px] text-[#82939a]">Each scan’s selected contract is checked against live ticks for 30 seconds.</p>
                  )}
                  <p className="mt-2 font-mono-ui text-[7px] leading-relaxed text-[#6f8792]">Wins / observed ticks.</p>
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
              <p data-testid="status-data-disclaimer" className="flex items-center gap-1.5 text-[9px] text-[#82939a]"><ShieldCheck size={12} className="text-[#62c9ae]" /> Live market data only; digit percentages describe recent ticks, not predictions or advice.</p>
              <button type="button" onClick={() => setNotice('Digit percentages use the latest 1,000 ticks. Data Analysis records live outcomes for 30 seconds after each scan.')} data-testid="button-data-info" className="flex items-center gap-1.5 text-[9px] font-bold tracking-[.05em] text-[#73b8c3] transition hover:text-[#a6edf0]"><CircleHelp size={12} /> DATA ANALYSIS</button>
            </footer>
          </div>
        </section>
        </div>
        <section id="scanner-section" aria-label="Market scanner" className="order-2 min-w-0 scroll-mt-4">
          <DigitScannerView
            markets={volatilityMarkets.map((item) => ({
              ...item,
              ticks: scannerTicksByMarket[item.symbol] ?? [],
              tickVersion: scannerTickVersionsByMarket[item.symbol] ?? 0,
            }))}
            contractType={settings.contractType}
            feedStatus={scannerFeedStatus}
            feedError={scannerFeedError}
            onMarketSelect={selectMarket}
            onPredictionStart={startPredictionOutcome}
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
                <a href="https://dbotpulse.site" target="_blank" rel="noopener noreferrer" className="rounded px-1 py-0.5 font-bold tracking-wider text-[#71e2d6] transition hover:bg-[#103334] hover:text-[#a0fff0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71e2d6]">
                  DBOTPULSE
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
