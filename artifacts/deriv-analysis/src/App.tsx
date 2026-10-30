import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  ChevronDown,
  CircleHelp,
  Clock3,
  Cpu,
  Gauge,
  Layers3,
  Menu,
  Radio,
  ScanLine,
  Settings2,
  ShieldCheck,
  Signal,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Home() {
  const markets = ['Volatility 100 Index', 'Volatility 75 Index', 'Volatility 50 (1s) Index', 'Boom 500 Index'];
  const cycleSteps = ['10 (1s)', '10 Index', '25 (1s)', '25 Index'];
  const [market, setMarket] = useState(markets[0]);
  const [step, setStep] = useState(cycleSteps[0]);
  const [autoScan, setAutoScan] = useState(true);
  const [countdown, setCountdown] = useState(19);
  const [notice, setNotice] = useState('');
  const [logExpanded, setLogExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [lastAction, setLastAction] = useState('Preview console initialized');

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCountdown((value) => (value <= 1 ? 19 : value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const runPreview = () => {
    setNotice('Sample preview refreshed — no market data requested.');
    setLastAction('Local preview refreshed');
    window.setTimeout(() => setNotice(''), 3400);
  };

  const confidence = market.includes('100') ? '93.9%' : market.includes('75') ? '91.6%' : market.includes('50') ? '88.4%' : '86.7%';

  return (
    <main className="min-h-[100dvh] px-3 pb-8 pt-3 text-[#dce6ef] sm:px-6 sm:pt-6">
      <div className="mx-auto max-w-[1160px]">
        <header className="mb-4 flex items-center justify-between gap-3 border-b border-[#263441] pb-3 sm:mb-6 sm:pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-[#b89a57]/50 bg-[#17232a] text-[#d3b66e] shadow-[inset_0_0_16px_rgba(202,172,97,.08)]">
              <Activity size={20} strokeWidth={1.8} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display text-[22px] font-bold leading-none tracking-[.09em] text-[#f2f0e9]">DERIV<span className="text-[#36d4d0]"> / </span>CONSOLE</span>
                <span className="hidden rounded border border-[#c7a34e]/45 px-1.5 py-[3px] font-mono-ui text-[9px] tracking-[.15em] text-[#ceb66d] sm:inline">PREVIEW BUILD</span>
              </div>
              <p className="mt-1 text-[10px] tracking-[.1em] text-[#778894]">SYNTHETIC MARKET ANALYSIS · UI PREVIEW</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div data-testid="status-preview-mode" className="hidden items-center gap-2 rounded-full border border-[#1d7577]/55 bg-[#0d3338]/50 px-3 py-1.5 sm:flex">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#42d8d2]" />
              <span className="font-mono-ui text-[10px] tracking-[.12em] text-[#6de4dc]">PREVIEW MODE</span>
            </div>
            <button type="button" onClick={() => setNotice('Notifications are disabled in this preview.')} aria-label="Notifications" data-testid="button-notifications" className="grid h-9 w-9 place-items-center rounded-lg border border-[#263441] bg-[#101a22] text-[#a5b2bc] transition hover:border-[#447985] hover:text-[#54d8d6]">
              <Bell size={16} />
            </button>
            <button type="button" onClick={() => setNotice('Settings are not connected in preview mode.')} aria-label="Settings" data-testid="button-settings" className="grid h-9 w-9 place-items-center rounded-lg border border-[#263441] bg-[#101a22] text-[#a5b2bc] transition hover:border-[#447985] hover:text-[#54d8d6]">
              <Settings2 size={16} />
            </button>
          </div>
        </header>

        <nav className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-[#263441] sm:mb-5" aria-label="Dashboard sections">
          {[
            { label: 'Dashboard', icon: BarChart3 },
            { label: 'Cycle map', icon: Layers3 },
            { label: 'Activity log', icon: Menu },
          ].map(({ label, icon: Icon }) => (
            <button key={label} type="button" onClick={() => { setActiveTab(label); if (label === 'Activity log') setLogExpanded(true); }} data-testid={`tab-${label.toLowerCase().replace(' ', '-')}`} className={`relative flex shrink-0 items-center gap-2 px-3 py-2.5 text-[11px] font-bold tracking-[.08em] transition ${activeTab === label ? 'text-[#50d7d2] after:absolute after:inset-x-3 after:bottom-[-1px] after:h-[2px] after:bg-[#50d7d2]' : 'text-[#778894] hover:text-[#c4d2da]'}`}>
              <Icon size={14} />{label.toUpperCase()}
            </button>
          ))}
          <div className="ml-auto hidden items-center gap-2 pb-2 font-mono-ui text-[9px] tracking-wider text-[#6f808b] md:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#d6ad51]" /> SIMULATED ENVIRONMENT
          </div>
        </nav>

        {notice && <div role="status" data-testid="status-notice" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-[#1f7374]/50 bg-[#0e3034] px-3 py-2.5 text-[11px] text-[#9be7df] rise-in"><span>{notice}</span><button type="button" onClick={() => setNotice('')} data-testid="button-dismiss-notice" aria-label="Dismiss notice"><X size={14} /></button></div>}

        <section className="gold-frame scanline relative overflow-hidden rounded-[15px] bg-[#0e171f] p-3 sm:p-5">
          <div className="pointer-events-none absolute right-[-60px] top-[-110px] h-64 w-64 rounded-full bg-[#10bfc3]/[.06] blur-[70px]" />
          <div className="relative z-[1]">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="h-[2px] w-5 bg-[#d3ad5b]" />
                  <p className="font-mono-ui text-[9px] tracking-[.22em] text-[#d4b460]">MARKET ANALYSIS TOOL</p>
                </div>
                <h1 className="font-display text-[25px] font-bold leading-none tracking-[.065em] text-[#eef1ee] sm:text-[30px]">CYCLE <span className="text-[#42d7d2]">INSPECTOR</span></h1>
                <p className="mt-1.5 text-[10px] text-[#82939e]">A compact view of synthetic-market cycle samples.</p>
              </div>
              <span className="flex items-center gap-1.5 rounded-full border border-[#805d26]/60 bg-[#382b13]/35 px-2.5 py-1 font-mono-ui text-[9px] tracking-[.1em] text-[#d7b966]"><AlertTriangle size={11} /> SAMPLE VALUES</span>
            </div>

            <div className="mb-4 grid gap-2 sm:grid-cols-[1.08fr_1fr]">
              <label className="flex min-w-0 items-center gap-2 rounded-lg border border-[#23696b]/70 bg-[#10262b] px-3 py-2.5">
                <Radio size={15} className="shrink-0 text-[#45d6d0]" />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono-ui text-[8px] tracking-[.13em] text-[#7da4a6]">SELECTED MARKET · PREVIEW</span>
                  <select value={market} onChange={(event) => { setMarket(event.target.value); setLastAction('Selected sample market changed'); }} data-testid="select-market" aria-label="Select sample market" className="mt-1 w-full appearance-none bg-transparent pr-5 text-[12px] font-bold text-[#dff8f5] outline-none">
                    {markets.map((item) => <option key={item} value={item} className="bg-[#101a22]">{item}</option>)}
                  </select>
                </span>
                <ChevronDown size={14} className="shrink-0 text-[#6aa4a4]" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setAutoScan((value) => !value); setLastAction(`Auto-scan ${autoScan ? 'paused' : 'enabled'} locally`); }} aria-pressed={autoScan} data-testid="toggle-auto-scan" className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-[10px] font-extrabold tracking-[.04em] transition ${autoScan ? 'border-[#28777a] bg-[#10383a] text-[#64dfd8]' : 'border-[#394654] bg-[#19222b] text-[#aab6c0]'}`}>
                  <span className={`relative h-[14px] w-[25px] rounded-full transition ${autoScan ? 'bg-[#19aaa9]' : 'bg-[#43505b]'}`}><span className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-[#e5f7f3] transition-transform ${autoScan ? 'translate-x-[13px]' : 'translate-x-[2px]'}`} /></span>
                  AUTO-SCAN <span className="font-mono-ui text-[9px]">{autoScan ? 'ON' : 'OFF'}</span>
                </button>
                <button type="button" onClick={runPreview} data-testid="button-scan-preview" className="flex items-center justify-center gap-2 rounded-lg border border-[#c4a44e] bg-gradient-to-r from-[#b68a31] to-[#e0bc5c] px-2 py-2.5 text-[10px] font-extrabold tracking-[.06em] text-[#211b10] shadow-[0_3px_15px_rgba(195,155,58,.14)] transition hover:brightness-110 active:translate-y-px"><Zap size={14} /> REFRESH SAMPLE</button>
                <button type="button" onClick={() => setActiveTab('Cycle map')} data-testid="button-open-cycles" className="flex items-center justify-center gap-2 rounded-lg border border-[#20697a] bg-[#102b39] px-2 py-2.5 text-[10px] font-bold tracking-[.04em] text-[#66c9e2] transition hover:border-[#42a6bd]"><Layers3 size={13} /> CYCLE MAP</button>
                <button type="button" onClick={() => setNotice('Entry section is informational only — no trading actions are available.')} data-testid="button-entry-info" className="flex items-center justify-center gap-2 rounded-lg border border-[#167d79] bg-[#0e4140] px-2 py-2.5 text-[10px] font-bold tracking-[.04em] text-[#73e5d9] transition hover:border-[#32b9ae]"><CircleHelp size={13} /> ENTRY INFO</button>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1.22fr_.78fr]">
              <div className="space-y-3">
                <section className="rounded-xl border border-[#30404c] bg-[#101b24]/90 p-3 sm:p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2"><div className="grid h-7 w-7 place-items-center rounded-md bg-[#3a301c] text-[#d7b760]"><Clock3 size={14} /></div><div><h2 className="text-[11px] font-extrabold tracking-[.1em] text-[#e3e8e6]">CANONICAL SCAN CYCLE</h2><p className="mt-0.5 font-mono-ui text-[9px] text-[#768a96]">DEMO SEQUENCE · NO SIGNALS</p></div></div>
                    <span data-testid="text-cycle-countdown" className="rounded-md border border-[#225a6a] bg-[#112a38] px-2.5 py-1.5 font-mono-ui text-[10px] text-[#71cce5]">NEXT IN <strong className="text-[#e3f8fa]">{countdown}s</strong></span>
                  </div>
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    {cycleSteps.map((item, index) => <div key={item} className="flex items-center gap-1.5">
                      <button type="button" onClick={() => { setStep(item); setLastAction(`Cycle step changed to ${item}`); }} aria-pressed={step === item} data-testid={`button-cycle-step-${index + 1}`} className={`rounded-md border px-2.5 py-1.5 font-mono-ui text-[10px] transition ${step === item ? 'border-[#2d8ec5] bg-[#123b64] text-[#8cdbff] shadow-[inset_0_0_12px_rgba(41,157,228,.1)]' : 'border-[#354653] bg-[#17232d] text-[#a3b0b8] hover:border-[#55717f]'}`}>{item}</button>
                      {index < cycleSteps.length - 1 && <span className="font-mono-ui text-[9px] text-[#61737e]">→</span>}
                    </div>)}
                  </div>
                  <div className="relative h-[96px] overflow-hidden rounded-lg border border-[#243745] bg-[#0c151d] px-2 py-2">
                    <div className="absolute inset-0 opacity-50" style={{ backgroundImage: 'linear-gradient(rgba(78,119,136,.13) 1px, transparent 1px), linear-gradient(90deg, rgba(78,119,136,.13) 1px, transparent 1px)', backgroundSize: '26px 24px' }} />
                    <div className="absolute left-2 top-2 z-[1] rounded bg-[#11242c]/90 px-1.5 py-1 font-mono-ui text-[8px] tracking-wider text-[#718994]">ILLUSTRATIVE TRACE</div>
                    <svg viewBox="0 0 640 96" preserveAspectRatio="none" className="relative h-full w-full" role="img" aria-label="Decorative illustrative sample trace, not market data">
                      <defs><linearGradient id="trace" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#23cbd0" stopOpacity=".24" /><stop offset="100%" stopColor="#23cbd0" stopOpacity="0" /></linearGradient></defs>
                      <path d="M0 65 L25 60 L45 70 L68 38 L87 51 L108 45 L130 58 L154 25 L176 34 L195 30 L218 55 L240 48 L260 61 L282 30 L302 37 L325 24 L346 41 L370 54 L390 43 L414 57 L436 22 L459 34 L480 46 L500 29 L524 48 L545 38 L567 62 L591 35 L612 43 L640 26 L640 96 L0 96 Z" fill="url(#trace)" />
                      <path d="M0 65 L25 60 L45 70 L68 38 L87 51 L108 45 L130 58 L154 25 L176 34 L195 30 L218 55 L240 48 L260 61 L282 30 L302 37 L325 24 L346 41 L370 54 L390 43 L414 57 L436 22 L459 34 L480 46 L500 29 L524 48 L545 38 L567 62 L591 35 L612 43 L640 26" fill="none" stroke="#35cbd0" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    </svg>
                    <span className="absolute bottom-1.5 right-2 font-mono-ui text-[8px] tracking-wider text-[#57717e]">DEMO GRAPHIC ONLY</span>
                  </div>
                </section>

                <section className="rounded-xl border border-[#30404c] bg-[#101b24]/90 p-3 sm:p-4">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <div className="mb-1 flex items-center gap-1.5"><span className="h-[2px] w-4 bg-[#d5ae59]" /><p className="font-mono-ui text-[8px] tracking-[.17em] text-[#d4b25f]">SAMPLE SNAPSHOT</p></div>
                      <h2 data-testid="text-selected-market" className="font-display text-[21px] font-bold leading-none tracking-[.06em] text-[#edf2f0] sm:text-[24px]">{market.toUpperCase()}</h2>
                    </div>
                    <div className="flex items-center gap-1 rounded-full border border-[#398b70]/50 bg-[#12352d]/70 px-2 py-1 font-mono-ui text-[8px] tracking-wider text-[#72d7aa]"><ShieldCheck size={11} /> DEMO DATA</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[#276c89] bg-[#102a3b] p-3 shadow-[inset_0_0_24px_rgba(38,141,190,.08)]">
                      <div className="flex items-center justify-between gap-2"><span className="font-mono-ui text-[8px] tracking-[.13em] text-[#72b6d2]">SAMPLE CONFIDENCE</span><Gauge size={14} className="text-[#52bfe1]" /></div>
                      <div data-testid="text-sample-confidence" className="mt-2 font-display text-[31px] font-bold leading-none text-[#d9f5ff]">{confidence}</div>
                      <div className="mt-1.5 flex items-center gap-1 text-[9px] text-[#87b7c7]"><span className="h-1 w-1 rounded-full bg-[#58c6dc]" /> Illustrative value only</div>
                    </div>
                    <div className="rounded-lg border border-[#236d69] bg-[#103330] p-3 shadow-[inset_0_0_24px_rgba(25,193,164,.08)]">
                      <div className="flex items-center justify-between gap-2"><span className="font-mono-ui text-[8px] tracking-[.13em] text-[#75cbbd]">SAMPLE COUNT</span><Activity size={14} className="text-[#48d1ba]" /></div>
                      <div data-testid="text-sample-count" className="mt-2 font-display text-[31px] font-bold leading-none text-[#d9fff1]">1,284</div>
                      <div className="mt-1.5 flex items-center gap-1 text-[9px] text-[#81c3b6]"><span className="h-1 w-1 rounded-full bg-[#53d8ad]" /> Fixed UI sample</div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#273743] bg-[#0d171e] px-3 py-2">
                    <span className="font-mono-ui text-[9px] tracking-[.1em] text-[#8b9ba3]">CURRENT CYCLE STEP</span>
                    <span data-testid="text-selected-cycle-step" className="rounded border border-[#2d6790] bg-[#142d43] px-2 py-1 font-mono-ui text-[10px] text-[#8bcbed]">{step}</span>
                  </div>
                </section>
              </div>

              <div className="space-y-3">
                <section className="rounded-xl border border-[#34515f] bg-[#111e27] p-3 sm:p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2"><div className="grid h-7 w-7 place-items-center rounded-md bg-[#38212c] text-[#f06b82]"><Clock3 size={14} /></div><div><h2 className="text-[11px] font-extrabold tracking-[.1em] text-[#e3e8e6]">PREVIEW TIMER</h2><p className="font-mono-ui text-[8px] tracking-wider text-[#778a95]">LOCAL UI DEMONSTRATION</p></div></div>
                    <span className="rounded border border-[#8e3146]/60 bg-[#3b1923]/70 px-2 py-1 font-mono-ui text-[8px] tracking-wider text-[#f28c9c]">NOT A SIGNAL</span>
                  </div>
                  <div className={`relative overflow-hidden rounded-xl border p-4 text-center transition-colors ${countdown <= 4 ? 'border-[#ba4057] bg-[#451a28]' : 'border-[#246284] bg-[#102842]'}`}>
                    <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-[#26bace] to-transparent opacity-70" />
                    <div className="font-mono-ui text-[9px] tracking-[.2em] text-[#93b5c8]">COUNTDOWN PREVIEW</div>
                    <div data-testid="text-preview-countdown" className={`mt-1 font-display text-[58px] font-bold leading-none tracking-[.02em] ${countdown <= 4 ? 'text-[#ff7c92]' : 'text-[#70c9ff]'}`}>{countdown}<span className="ml-1 text-[20px]">s</span></div>
                    <div className="mx-auto mt-3 h-1.5 max-w-[250px] overflow-hidden rounded-full bg-[#263d4b]"><div className={`h-full rounded-full transition-[width] duration-700 ${countdown <= 4 ? 'bg-[#ef5c77]' : 'bg-[#2bc4cb]'}`} style={{ width: `${(countdown / 19) * 100}%` }} /></div>
                    <p className="mt-2 text-[9px] text-[#8aa0ae]">Cycles locally for interface preview only</p>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[#293a46] bg-[#0c171e] px-3 py-2.5"><p className="font-mono-ui text-[8px] tracking-[.11em] text-[#748995]">SAMPLE DIRECTION</p><div className="mt-1 flex items-center gap-1.5 text-[12px] font-bold text-[#a3d4cd]"><ArrowUpRight size={14} className="text-[#51cead]" /> Illustrative</div></div>
                    <div className="rounded-lg border border-[#293a46] bg-[#0c171e] px-3 py-2.5"><p className="font-mono-ui text-[8px] tracking-[.11em] text-[#748995]">SAMPLE WINDOW</p><div className="mt-1 flex items-center gap-1.5 text-[12px] font-bold text-[#c7d6df]"><ArrowDownRight size={14} className="text-[#829eae]" /> {step}</div></div>
                  </div>
                </section>

                <section className="rounded-xl border border-[#30404c] bg-[#101b24]/90 p-3 sm:p-4">
                  <button type="button" onClick={() => setLogExpanded((value) => !value)} aria-expanded={logExpanded} data-testid="button-toggle-status-log" className="flex w-full items-center justify-between text-left">
                    <span className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-md bg-[#173034] text-[#56d5cc]"><Cpu size={14} /></span><span><span className="block text-[11px] font-extrabold tracking-[.1em] text-[#e4e9e7]">CONNECTION &amp; LOG</span><span className="mt-0.5 block font-mono-ui text-[8px] tracking-wider text-[#789099]">SIMULATED STATUS · NOT CONNECTED</span></span></span>
                    <ChevronDown size={15} className={`text-[#82939a] transition-transform ${logExpanded ? 'rotate-180' : ''}`} />
                  </button>
                  {logExpanded && <div className="mt-3 space-y-2 border-t border-[#273842] pt-3 rise-in">
                    <div data-testid="status-connection-preview" className="flex items-center justify-between gap-2 rounded-md bg-[#0c171d] px-2.5 py-2"><span className="flex items-center gap-2 text-[10px] text-[#a5b4bb]"><Wifi size={13} className="text-[#4dcbb9]" /> Deriv WebSocket</span><span className="flex items-center gap-1 font-mono-ui text-[8px] tracking-wider text-[#dbb65a]"><span className="h-1.5 w-1.5 rounded-full bg-[#dbb65a]" /> PREVIEW ONLY</span></div>
                    <div className="flex items-center justify-between gap-2 rounded-md bg-[#0c171d] px-2.5 py-2"><span className="flex items-center gap-2 text-[10px] text-[#a5b4bb]"><Signal size={13} className="text-[#58b8dc]" /> Bot synchronization</span><span className="font-mono-ui text-[8px] tracking-wider text-[#8a9aa1]">NOT CONNECTED</span></div>
                    <div className="flex items-start gap-2 rounded-md border border-[#273842] bg-[#0c171d] px-2.5 py-2.5"><span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#43cdc2]" /><div className="min-w-0"><p data-testid="text-latest-log" className="truncate text-[10px] text-[#b8c8ce]">{lastAction}</p><p className="mt-1 font-mono-ui text-[8px] tracking-wider text-[#637780]">LOCAL UI EVENT · SAMPLE ENVIRONMENT</p></div><span className="ml-auto shrink-0 font-mono-ui text-[8px] text-[#62767d]">NOW</span></div>
                    <p className="flex items-start gap-1.5 px-1 pt-0.5 text-[9px] leading-relaxed text-[#7d8f98]"><AlertTriangle size={11} className="mt-0.5 shrink-0 text-[#c4a754]" /> Connection labels are placeholders. No network or market feed is active.</p>
                  </div>}
                </section>
              </div>
            </div>

            <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#293944] pt-3">
              <p data-testid="status-data-disclaimer" className="flex items-center gap-1.5 text-[9px] text-[#82939a]"><ShieldCheck size={12} className="text-[#62c9ae]" /> PREVIEW UI · All values are sample content, not analysis or advice.</p>
              <button type="button" onClick={() => setNotice('This preview has no external data connections.')} data-testid="button-data-info" className="flex items-center gap-1.5 text-[9px] font-bold tracking-[.05em] text-[#73b8c3] transition hover:text-[#a6edf0]"><CircleHelp size={12} /> ABOUT SAMPLE DATA</button>
            </footer>
          </div>
        </section>
        <p className="mx-auto mt-3 max-w-4xl text-center font-mono-ui text-[8px] leading-relaxed tracking-[.08em] text-[#566872]">DERIV MARKET ANALYSIS CONSOLE <span className="mx-1 text-[#a98b4d]">/</span> LOCAL INTERACTION DEMO <span className="mx-1 text-[#a98b4d]">/</span> TRADING DISABLED</p>
      </div>
    </main>
  );
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
