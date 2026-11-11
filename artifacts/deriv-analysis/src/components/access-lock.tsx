import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LockKeyhole } from 'lucide-react';

type AccessContextValue = { lockApp: () => Promise<void> };
const AccessContext = createContext<AccessContextValue | null>(null);

type AccessGateProps = { children: ReactNode };
type GateState = 'checking' | 'locked' | 'unavailable' | 'unlocked';

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
    <main className="grid min-h-[100dvh] place-items-center bg-[#071620] px-4 py-8 text-[#dce6ef]">
      <section className="w-full max-w-sm rounded-2xl border border-[#236b72] bg-gradient-to-br from-[#0c2831] to-[#101b24] p-6 shadow-[0_20px_70px_rgba(0,0,0,.4)]">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl border border-[#2ca99e]/50 bg-[#103a38] text-[#71e2d6]">
            {state === 'checking' ? <LockKeyhole size={21} /> : <KeyRound size={21} />}
          </div>
          <div>
            <h1 className="font-display text-lg font-bold tracking-wider text-[#f2f0e9]">ONE-MARKET</h1>
            <p className="mt-1 text-[10px] tracking-wide text-[#9bb8bc]">LOCKED · ACCESS KEY REQUIRED</p>
          </div>
        </div>
        {state === 'checking' && (
          <p role="status" className="mb-3 text-xs text-[#b3c9cc]">Checking secure access…</p>
        )}
        {state === 'unavailable' && (
          <div className="mb-3 space-y-3">
            <div role="alert" className="rounded-lg border border-[#875c31] bg-[#322819] p-3 text-sm text-[#f5d69c]">
              {error || 'Secure access is unavailable. Access remains locked.'}
            </div>
            <button type="button" onClick={retry} className="h-10 w-full rounded-lg border border-[#315761] bg-[#102a33] text-xs font-bold tracking-wider text-[#b3d3d5] hover:border-[#55d9ca]">
              RETRY SESSION CHECK
            </button>
          </div>
        )}
        <form onSubmit={unlock} className="space-y-4">
          <label htmlFor="access-key" className="block text-xs font-semibold text-[#c2d6d8]">
            Enter your access key
          </label>
          <input
            id="access-key"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            className="h-11 w-full rounded-lg border border-[#315761] bg-[#071a23] px-3 font-mono-ui text-sm tracking-[.18em] text-white outline-none transition focus:border-[#55d9ca] focus:ring-2 focus:ring-[#1c9d93]/30"
            aria-describedby={error && state !== 'unavailable' ? 'access-error' : undefined}
          />
          {error && state !== 'unavailable' && <p id="access-error" role="alert" className="text-xs text-[#ffaaa0]">{error}</p>}
          <button
            type="submit"
            disabled={submitting || password.length === 0}
            className="h-11 w-full rounded-lg border border-[#22a89a] bg-gradient-to-r from-[#087b83] to-[#136a91] text-xs font-extrabold tracking-widest text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'VERIFYING…' : 'UNLOCK APP'}
          </button>
        </form>
      </section>
    </main>
  );
}
