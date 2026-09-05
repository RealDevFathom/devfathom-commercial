'use client';

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

type DemoSeat = { seat: number; name: string; ready: boolean };
type EntryPhase = 'idle' | 'requesting-access' | 'signing-in' | 'preparing-seat';

const SEAT_LIST_UNAVAILABLE = 'Presentation seats are unavailable. Retry in a moment.';

function isDemoSeat(value: unknown): value is DemoSeat {
  if (!value || typeof value !== 'object') return false;
  const seat = value as Partial<DemoSeat>;
  return (
    Number.isInteger(seat.seat) &&
    Number(seat.seat) > 0 &&
    typeof seat.name === 'string' &&
    seat.name.trim().length > 0 &&
    typeof seat.ready === 'boolean'
  );
}

function retryAfterSeconds(response: Response, payload: unknown) {
  const bodyValue =
    payload && typeof payload === 'object' && 'retryAfter' in payload
      ? Number(payload.retryAfter)
      : Number.NaN;
  if (Number.isFinite(bodyValue) && bodyValue > 0) return Math.ceil(bodyValue);

  const header = response.headers.get('Retry-After');
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 0 : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function responseError(payload: unknown, fallback: string) {
  return payload && typeof payload === 'object' && 'error' in payload
    ? String(payload.error)
    : fallback;
}

export function DemoRestaurantEntryClient() {
  const router = useRouter();
  const requestRef = useRef<AbortController | null>(null);
  const [seats, setSeats] = useState<DemoSeat[]>([]);
  const [selectedSeat, setSelectedSeat] = useState('');
  const [code, setCode] = useState('');
  const [seatError, setSeatError] = useState('');
  const [authError, setAuthError] = useState('');
  const [loadingSeats, setLoadingSeats] = useState(true);
  const [phase, setPhase] = useState<EntryPhase>('idle');
  const [retrySeconds, setRetrySeconds] = useState(0);

  const loadSeats = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoadingSeats(true);
    setSeatError('');

    try {
      const response = await fetch('/demo/restaurants/seats', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).catch(() => {
        throw new Error(SEAT_LIST_UNAVAILABLE);
      });
      if (response.status === 500) throw new Error(SEAT_LIST_UNAVAILABLE);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload, 'Demo seats could not be loaded.'));
      const values =
        payload && typeof payload === 'object' && 'seats' in payload && Array.isArray(payload.seats)
          ? payload.seats.filter(isDemoSeat)
          : [];
      if (values.length === 0) throw new Error('No demo seats are configured yet.');

      setSeats(values);
      setSelectedSeat((current) => {
        if (values.some((seat) => seat.ready && String(seat.seat) === current)) return current;
        return String(values.find((seat) => seat.ready)?.seat ?? '');
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setSeats([]);
      setSelectedSeat('');
      setSeatError(error instanceof Error ? error.message : 'Demo seats could not be loaded.');
    } finally {
      if (!controller.signal.aborted) setLoadingSeats(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadSeats(), 0);
    return () => {
      window.clearTimeout(timeout);
      requestRef.current?.abort();
    };
  }, [loadSeats]);

  useEffect(() => {
    if (retrySeconds <= 0) return;
    const timeout = window.setTimeout(
      () => setRetrySeconds((current) => Math.max(0, current - 1)),
      1_000
    );
    return () => window.clearTimeout(timeout);
  }, [retrySeconds]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== 'idle' || retrySeconds > 0) return;
    const seat = Number(selectedSeat);
    if (!Number.isInteger(seat) || !seats.some((option) => option.ready && option.seat === seat)) {
      setAuthError('Choose an available demo seat.');
      return;
    }

    setAuthError('');
    setPhase('requesting-access');
    try {
      const accessResponse = await fetch('/demo/restaurants/access', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, seat }),
      });
      const access: unknown = await accessResponse.json().catch(() => null);
      if (!accessResponse.ok) {
        if (accessResponse.status === 429) {
          setRetrySeconds(Math.max(1, retryAfterSeconds(accessResponse, access)));
        }
        throw new Error(responseError(access, 'Demo access failed. Check the code and try again.'));
      }
      if (
        !access ||
        typeof access !== 'object' ||
        !('organizationId' in access) ||
        typeof access.organizationId !== 'string' ||
        !access.organizationId ||
        !('callbackUrl' in access) ||
        access.callbackUrl !== '/dashboard'
      ) {
        throw new Error('Demo access returned an invalid response.');
      }

      setPhase('signing-in');
      const result = await signIn('login-intent', {
        organizationId: access.organizationId,
        redirect: false,
        callbackUrl: access.callbackUrl,
      });
      if (!result || result.error || result.ok === false) {
        throw new Error('The demo workspace could not be signed in. Try again.');
      }

      setPhase('preparing-seat');
      const deviceResponse = await fetch('/demo/restaurants/device-session', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const device: unknown = await deviceResponse.json().catch(() => null);
      if (
        !deviceResponse.ok ||
        !device ||
        typeof device !== 'object' ||
        !('ready' in device) ||
        device.ready !== true
      ) {
        throw new Error(responseError(device, 'The demo seat could not be prepared. Try again.'));
      }

      router.replace('/dashboard');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Demo access failed. Try again.');
      setPhase('idle');
    }
  }

  const pending = phase !== 'idle';
  const pendingLabel =
    phase === 'requesting-access'
      ? 'Checking access…'
      : phase === 'signing-in'
        ? 'Signing in…'
        : phase === 'preparing-seat'
          ? 'Preparing your seat…'
          : 'Enter restaurant demo';

  return (
    <main className="min-h-svh bg-surface-page lg:bg-surface-surround lg:p-[22px]">
      <div className="mx-auto grid min-h-svh max-w-[1600px] overflow-hidden bg-surface-page lg:min-h-[calc(100svh-44px)] lg:grid-cols-[minmax(20rem,0.8fr)_minmax(32rem,1.2fr)] lg:rounded-[36px]">
        <section className="relative hidden overflow-hidden bg-primary p-10 text-primary-foreground lg:flex lg:flex-col lg:justify-between xl:p-14">
          <Logo variant="auto" size="lg" className="text-primary-foreground" />
          <div className="max-w-md space-y-5">
            <p className="font-mono text-xs tracking-[0.16em] text-primary-foreground/60 uppercase">
              Restaurant operations
            </p>
            <h2 className="font-display text-4xl leading-tight font-semibold tracking-tight xl:text-5xl">
              Walk the full service day in one calm workspace.
            </h2>
            <p className="text-base leading-relaxed text-primary-foreground/70">
              Explore seeded branches, POS, kitchen, inventory, purchasing, close, and reports
              without touching another presenter&apos;s data.
            </p>
          </div>
          <p className="font-mono text-xs text-primary-foreground/50">
            ISOLATED SALES WORKSPACE · PKR
          </p>
        </section>

        <section className="flex min-w-0 items-center px-4 py-8 sm:px-8 lg:px-12 xl:px-20">
          <div className="mx-auto w-full max-w-2xl">
            <Logo className="mb-10 lg:hidden" size="lg" />
            <PageHeader
              eyebrow="Guided workspace"
              heading="Restaurant demo"
              description="Choose an available presentation seat and enter the shared access code. Your seat resets independently."
            />

            <SectionCard title="Enter the workspace" titleLevel={2}>
              <form className="space-y-6" onSubmit={submit} noValidate>
                <div className="space-y-2">
                  <label className="text-sm font-semibold text-text-strong" htmlFor="demo-code">
                    Access code
                  </label>
                  <input
                    id="demo-code"
                    name="code"
                    type="password"
                    autoComplete="current-password"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    aria-invalid={Boolean(authError)}
                    aria-describedby={authError ? 'demo-entry-error' : undefined}
                    disabled={pending}
                    className="h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-base text-text-strong outline-none transition focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>

                <fieldset className="space-y-3" disabled={pending || loadingSeats}>
                  <legend className="text-sm font-semibold text-text-strong">
                    Presentation seat
                  </legend>
                  {loadingSeats ? (
                    <p
                      className="rounded-md border border-border-subtle bg-surface-sunken p-4 text-sm text-text-muted"
                      role="status"
                    >
                      Loading available seats…
                    </p>
                  ) : seatError ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
                      <p className="text-sm text-destructive" role="alert">
                        {seatError}
                      </p>
                      <Button className="mt-3" type="button" variant="outline" onClick={loadSeats}>
                        Retry seat list
                      </Button>
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {seats.map((seat) => {
                        const id = `demo-seat-${seat.seat}`;
                        return (
                          <label
                            key={seat.seat}
                            htmlFor={id}
                            className="flex min-h-14 cursor-pointer items-center gap-3 rounded-md border border-border-subtle bg-card p-3 transition hover:border-border-strong has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30 has-[:checked]:border-border-strong has-[:checked]:bg-surface-sunken has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55"
                          >
                            <input
                              id={id}
                              type="radio"
                              name="seat"
                              value={seat.seat}
                              checked={selectedSeat === String(seat.seat)}
                              disabled={!seat.ready}
                              onChange={(event) => setSelectedSeat(event.target.value)}
                              className="size-4 accent-[var(--primary)]"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-text-strong">
                                {seat.name}
                              </span>
                              <span className="font-mono text-[0.6875rem] tracking-wide text-text-muted uppercase">
                                {seat.ready
                                  ? `Seat ${seat.seat} · Ready`
                                  : `Seat ${seat.seat} · Resetting`}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </fieldset>

                {authError ? (
                  <p
                    id="demo-entry-error"
                    className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                    role="alert"
                  >
                    {authError}
                  </p>
                ) : null}

                <Button
                  className="h-11 w-full"
                  size="lg"
                  type="submit"
                  disabled={pending || loadingSeats || !selectedSeat || retrySeconds > 0}
                >
                  {retrySeconds > 0 ? `Try again in ${retrySeconds}s` : pendingLabel}
                </Button>
                <p
                  className="text-center text-xs leading-relaxed text-text-muted"
                  aria-live="polite"
                >
                  {pending
                    ? pendingLabel
                    : retrySeconds > 0
                      ? `Access is rate limited for ${retrySeconds} seconds.`
                      : 'Demo activity stays inside your selected seat.'}
                </p>
                <p className="text-center text-xs leading-relaxed text-text-muted">
                  Returning? Continue without re-entering your code.
                </p>
              </form>
            </SectionCard>
          </div>
        </section>
      </div>
    </main>
  );
}
