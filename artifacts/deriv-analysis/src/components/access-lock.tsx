import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff, KeyRound, LockKeyhole } from 'lucide-react';

type AccessContextValue = { lockApp: () => Promise<void> };
const AccessContext = createContext<AccessContextValue | null>(null);

type AccessGateProps = { children: ReactNode };
type GateState = 'checking' | 'locked' | 'unavailable' | 'unlocked';
type Candle = { open: number; close: number; high: number; low: number; volume: number };

function TradingBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef({ x: -1, y: -1 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const candles: Candle[] = [];
    let price = 100;
    for (let index = 0; index < 64; index += 1) {
      const open = price;
      price += (Math.random() - 0.49) * 1.2;
      candles.push({
        open,
        close: price,
        high: Math.max(open, price) + Math.random() * 0.55,
        low: Math.min(open, price) - Math.random() * 0.55,
        volume: 0.15 + Math.random() * 0.85,
      });
    }

    let frame = 0;
    let lastTimestamp = 0;
    let tickElapsed = 0;
    let candleElapsed = 0;
    let disposed = false;

    const draw = (timestamp: number) => {
      if (disposed) return;
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) {
        frame = window.requestAnimationFrame(draw);
        return;
      }

      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.round(bounds.width * pixelRatio);
      const height = Math.round(bounds.height * pixelRatio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const viewWidth = bounds.width;
      const viewHeight = bounds.height;
      context.clearRect(0, 0, viewWidth, viewHeight);

      if (lastTimestamp > 0 && !motionPreference.matches) {
        const elapsed = Math.min(timestamp - lastTimestamp, 100);
        tickElapsed += elapsed;
        candleElapsed += elapsed;
        while (tickElapsed >= 180) {
          tickElapsed -= 180;
          const current = candles[candles.length - 1];
          current.close += (Math.random() - 0.49) * 0.22;
          current.high = Math.max(current.high, current.close);
          current.low = Math.min(current.low, current.close);
          current.volume = Math.min(1, current.volume + Math.random() * 0.08);
        }
        if (candleElapsed >= 1800) {
          candleElapsed %= 1800;
          const open = candles[candles.length - 1].close;
          const close = open + (Math.random() - 0.49) * 1.05;
          candles.push({
            open,
            close,
            high: Math.max(open, close) + Math.random() * 0.45,
            low: Math.min(open, close) - Math.random() * 0.45,
            volume: 0.15 + Math.random() * 0.85,
          });
          candles.shift();
        }
      }
      lastTimestamp = timestamp;

      const left = 28;
      const right = viewWidth - 46;
      const top = 36;
      const bottom = viewHeight - 36;
      const plotHeight = Math.max(1, bottom - top);
      const minPrice = Math.min(...candles.map((candle) => candle.low));
      const maxPrice = Math.max(...candles.map((candle) => candle.high));
      const padding = Math.max((maxPrice - minPrice) * 0.16, 0.5);
      const rangeMin = minPrice - padding;
      const rangeMax = maxPrice + padding;
      const yFor = (value: number) => top + ((rangeMax - value) / (rangeMax - rangeMin)) * plotHeight;

      context.lineWidth = 1;
      context.font = '10px "DM Mono", monospace';
      for (let index = 0; index <= 5; index += 1) {
        const y = top + (plotHeight * index) / 5;
        context.strokeStyle = 'rgba(177, 231, 244, 0.09)';
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(right, y);
        context.stroke();
        const value = rangeMax - ((rangeMax - rangeMin) * index) / 5;
        context.fillStyle = 'rgba(193, 224, 235, 0.48)';
        context.fillText(value.toFixed(2), right + 7, y + 3);
      }
      for (let index = 0; index <= 8; index += 1) {
        const x = left + ((right - left) * index) / 8;
        context.strokeStyle = 'rgba(177, 231, 244, 0.085)';
        context.beginPath();
        context.moveTo(x, top);
        context.lineTo(x, bottom);
        context.stroke();
      }

      context.fillStyle = 'rgba(83, 219, 224, 0.045)';
      context.fillRect(left, bottom + 8, right - left, 24);
      const slotWidth = (right - left) / candles.length;
      const bodyWidth = Math.max(2, slotWidth * 0.52);
      context.save();
      context.shadowBlur = 12;
      candles.forEach((candle, index) => {
        const x = left + slotWidth * (index + 0.5);
        const rising = candle.close >= candle.open;
        const color = rising ? '70, 225, 195' : '255, 112, 132';
        const openY = yFor(candle.open);
        const closeY = yFor(candle.close);
        context.shadowColor = `rgba(${color}, .75)`;
        context.strokeStyle = `rgba(${color}, 0.56)`;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x, yFor(candle.high));
        context.lineTo(x, yFor(candle.low));
        context.stroke();
        context.fillStyle = `rgba(${color}, 0.88)`;
        context.fillRect(x - bodyWidth / 2, Math.min(openY, closeY), bodyWidth, Math.max(Math.abs(closeY - openY), 1.2));
        context.shadowBlur = 0;
        context.fillStyle = `rgba(${color}, 0.29)`;
        context.fillRect(x - bodyWidth / 2, bottom + 31 - candle.volume * 20, bodyWidth, candle.volume * 20);
        context.shadowBlur = 12;
      });
      context.restore();

      context.save();
      context.beginPath();
      candles.forEach((candle, index) => {
        const x = left + slotWidth * (index + 0.5);
        const y = yFor(candle.close);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      const trend = context.createLinearGradient(left, top, right, bottom);
      trend.addColorStop(0, 'rgba(91, 220, 255, .12)');
      trend.addColorStop(.55, 'rgba(108, 163, 255, .88)');
      trend.addColorStop(1, 'rgba(137, 255, 225, .95)');
      context.strokeStyle = trend;
      context.lineWidth = 1.7;
      context.shadowColor = 'rgba(86, 190, 255, .75)';
      context.shadowBlur = 10;
      context.stroke();
      context.restore();

      const sweepProgress = (timestamp % 7200) / 7200;
      const sweepX = left + sweepProgress * (right - left);
      const sweep = context.createLinearGradient(sweepX - 28, 0, sweepX + 28, 0);
      sweep.addColorStop(0, 'rgba(65, 220, 255, 0)');
      sweep.addColorStop(.5, 'rgba(65, 220, 255, .11)');
      sweep.addColorStop(1, 'rgba(65, 220, 255, 0)');
      context.fillStyle = sweep;
      context.fillRect(sweepX - 28, top, 56, bottom - top);
      context.strokeStyle = 'rgba(96, 235, 255, .44)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(sweepX, top);
      context.lineTo(sweepX, bottom);
      context.stroke();

      for (let index = 0; index < 26; index += 1) {
        const drift = motionPreference.matches ? 0 : timestamp * (0.008 + (index % 4) * 0.003);
        const x = (index * 137.5 + drift) % viewWidth;
        const y = (index * 83.7 + Math.sin(timestamp * 0.0007 + index) * 18 + viewHeight) % viewHeight;
        const alpha = .12 + ((Math.sin(timestamp * .001 + index * 2) + 1) * .12);
        context.fillStyle = `rgba(131, 231, 255, ${alpha})`;
        context.beginPath();
        context.arc(x, y, index % 6 === 0 ? 1.5 : .8, 0, Math.PI * 2);
        context.fill();
      }

      const pointer = pointerRef.current;
      if (pointer.x >= left && pointer.x <= right && pointer.y >= top && pointer.y <= bottom) {
        context.save();
        context.setLineDash([3, 5]);
        context.strokeStyle = 'rgba(147, 245, 255, .36)';
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(pointer.x, top);
        context.lineTo(pointer.x, bottom);
        context.moveTo(left, pointer.y);
        context.lineTo(right, pointer.y);
        context.stroke();
        context.setLineDash([]);
        const pointerGlow = context.createRadialGradient(pointer.x, pointer.y, 1, pointer.x, pointer.y, 30);
        pointerGlow.addColorStop(0, 'rgba(146, 255, 246, .5)');
        pointerGlow.addColorStop(1, 'rgba(146, 255, 246, 0)');
        context.fillStyle = pointerGlow;
        context.beginPath();
        context.arc(pointer.x, pointer.y, 30, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = 'rgba(187, 255, 251, .88)';
        context.beginPath();
        context.arc(pointer.x, pointer.y, 5, 0, Math.PI * 2);
        context.stroke();
        context.restore();
      }

      const currentY = yFor(candles[candles.length - 1].close);
      context.setLineDash([4, 5]);
      context.strokeStyle = 'rgba(95, 235, 230, 0.52)';
      context.beginPath();
      context.moveTo(left, currentY);
      context.lineTo(right, currentY);
      context.stroke();
      context.setLineDash([]);
      const glow = context.createRadialGradient(right, currentY, 1, right, currentY, 22);
      glow.addColorStop(0, 'rgba(104, 255, 225, 0.52)');
      glow.addColorStop(1, 'rgba(104, 255, 225, 0)');
      context.fillStyle = glow;
      context.beginPath();
      context.arc(right, currentY, 22, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = 'rgba(133, 255, 228, 0.95)';
      context.beginPath();
      context.arc(right, currentY, 3, 0, Math.PI * 2);
      context.fill();

      if (!motionPreference.matches) {
        frame = window.requestAnimationFrame(draw);
      }
    };

    const handleMotionChange = () => {
      window.cancelAnimationFrame(frame);
      lastTimestamp = 0;
      frame = window.requestAnimationFrame(draw);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const bounds = canvas.getBoundingClientRect();
      pointerRef.current = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
      backdropRef.current?.style.setProperty('--access-pointer-x', `${pointerRef.current.x}px`);
      backdropRef.current?.style.setProperty('--access-pointer-y', `${pointerRef.current.y}px`);
      if (motionPreference.matches) draw(performance.now());
    };
    const handlePointerLeave = () => {
      pointerRef.current = { x: -1, y: -1 };
      if (motionPreference.matches) draw(performance.now());
    };

    frame = window.requestAnimationFrame(draw);
    window.addEventListener('resize', handleMotionChange);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerleave', handlePointerLeave);
    motionPreference.addEventListener('change', handleMotionChange);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleMotionChange);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerleave', handlePointerLeave);
      motionPreference.removeEventListener('change', handleMotionChange);
    };
  }, []);

  return (
    <div ref={backdropRef} aria-hidden="true" className="access-trading-backdrop pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <canvas ref={canvasRef} className="access-market-chart absolute inset-0 h-full w-full" />
      <div className="access-pointer-glow absolute inset-0" />
      <div className="access-neon-haze absolute -inset-[20%]" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(4,15,24,.24),rgba(4,15,24,.025)_48%,rgba(4,15,24,.2)),linear-gradient(0deg,rgba(4,15,24,.42),transparent_35%,rgba(4,15,24,.16)]" />
    </div>
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return body.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function useAppLock(): AccessContextValue {
  const context = useContext(AccessContext);
  if (!context) throw new Error('useAppLock must be used inside AccessGate.');
  return context;
}

export function AccessGate({ children }: AccessGateProps) {
  const [state, setState] = useState<GateState>('checking');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    const verify = async () => {
      try {
        const response = await fetch('/api/access/session', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!active) return;
        if (response.ok) {
          setState('unlocked');
          setError('');
        } else if (response.status === 401) {
          setState('locked');
          setError('');
        } else {
          setState('locked');
          setError('');
        }
      } catch {
        if (active) {
          setState('locked');
          setError('');
        }
      }
    };
    void verify();
    const timer = window.setInterval(() => {
      if (state === 'unlocked') void verify();
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [state]);

  const lockApp = async () => {
    const response = await fetch('/api/access/lock', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('The app could not be locked. Try again.');
    setState('locked');
    setPassword('');
  };

  const unlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const response = await fetch('/api/access/unlock', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const serviceUnavailable = response.status >= 500;
        setError(serviceUnavailable
          ? 'The access service is unavailable. Please try again later.'
          : await readError(response, 'That access key is not valid.'));
        if (serviceUnavailable) setState('unavailable');
        return;
      }
      setPassword('');
      setState('unlocked');
    } catch {
      setError('The access service is unavailable. Please try again later.');
      setState('unavailable');
    } finally {
      setSubmitting(false);
    }
  };

  if (state === 'unlocked') {
    return (
      <AccessContext.Provider value={{ lockApp }}>
        {children}
      </AccessContext.Provider>
    );
  }

  const retry = () => {
    setError('');
    setState('checking');
  };
  return (
    <main className="relative isolate grid min-h-[100dvh] overflow-hidden place-items-center bg-[#06131d] px-4 py-8 text-[#e5f7fb]">
      <TradingBackdrop />
      <section className="access-glass-card relative isolate w-full max-w-sm overflow-hidden rounded-[30px] p-6 sm:p-8">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[radial-gradient(ellipse_at_18%_0%,rgba(255,255,255,.19),transparent_48%),linear-gradient(145deg,rgba(255,255,255,.075),transparent_45%,rgba(111,231,255,.055)]" />
        <div className="access-glass-highlight pointer-events-none absolute inset-x-8 top-0 h-px" />
        <div className="relative mb-6 flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl border border-cyan-100/25 bg-gradient-to-br from-cyan-200/20 to-sky-400/5 text-cyan-100 shadow-[inset_0_1px_0_rgba(255,255,255,.24),0_8px_24px_rgba(34,211,238,.12)]">
            {state === 'checking' ? <LockKeyhole size={21} /> : <KeyRound size={21} />}
          </div>
          <div>
            <h1 className="font-display text-lg font-bold tracking-wider text-[#f2f0e9]">ONE-MARKET</h1>
            <p className="mt-1 text-[10px] tracking-[.16em] text-cyan-100/65">SECURE ACCESS</p>
          </div>
        </div>
        {state === 'checking' && (
          <p role="status" className="mb-3 text-xs text-cyan-50/70">Checking secure access…</p>
        )}
        {state === 'unavailable' && (
          <div className="mb-4 space-y-3">
            <div role="alert" className="rounded-xl border border-amber-100/20 bg-amber-200/[0.08] p-3 text-sm text-amber-100">
              {error || 'Secure access is unavailable. Access remains locked.'}
            </div>
            <button type="button" onClick={retry} className="h-10 w-full rounded-xl border border-white/15 bg-white/[0.06] text-xs font-bold tracking-wider text-cyan-50/80 transition hover:border-cyan-100/40 hover:bg-white/10">
              RETRY SESSION CHECK
            </button>
          </div>
        )}
        <form onSubmit={unlock} className="relative space-y-5">
          <label htmlFor="access-key" className="block text-xs font-semibold tracking-wide text-cyan-50/85">
            Enter your access key
          </label>
          <div className="relative">
            <input
              id="access-key"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              className="access-glass-input h-12 w-full rounded-xl px-4 pr-12 font-mono-ui text-sm tracking-[.18em] text-white outline-none transition placeholder:text-white/35 focus:border-cyan-100/55 focus:ring-2 focus:ring-cyan-200/20"
              aria-describedby={error ? 'access-error' : undefined}
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? 'Hide access key' : 'Show access key'}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-xl text-cyan-50/60 transition hover:text-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-100/60"
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          {error && <p id="access-error" role="alert" className="text-xs text-rose-200">{error}</p>}
          <button
            type="submit"
            disabled={submitting || password.length === 0}
            className="access-glass-button h-12 w-full rounded-xl text-xs font-extrabold tracking-[.2em] text-cyan-50 transition hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting ? 'VERIFYING…' : 'UNLOCK APP'}
          </button>
        </form>
      </section>
    </main>
  );
}
