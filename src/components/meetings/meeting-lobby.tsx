'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, Clock, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/brand/logo';
import { MeetingLobbyHero } from '@/components/meetings/meeting-lobby-hero';
import type { MeetingAdmission } from '@/lib/meetings/admission-contract';

/**
 * The LiveKit client is ~hundreds of KB and is useless until admission
 * succeeds. This route is an unauthenticated, frequently-mobile first
 * impression, so the SDK is fetched only once there is a token to use it with.
 */
const MeetingCall = dynamic(
  () => import('@/components/meetings/meeting-call').then((m) => m.MeetingCall),
  { ssr: false, loading: () => <LobbyStatus>Starting the call…</LobbyStatus> }
);

const GENERIC_ERROR = 'This meeting is unavailable or the access code is invalid.';

/** How often a caller already held in the lobby re-checks for admission. */
const WAITING_POLL_MS = 5000;

function LobbyStatus({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6" aria-busy="true">
      <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-text-muted uppercase">
        {children}
      </p>
    </main>
  );
}

type Outcome =
  | { kind: 'unknown' }
  | { kind: 'admitted'; admission: MeetingAdmission }
  | { kind: 'waiting' }
  | { kind: 'refused' };

export function MeetingLobby({ publicId }: { publicId: string }) {
  const [accessCode, setAccessCode] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'unknown' });
  // Distinguishes "still checking the signed-in path on entry" from "the
  // visitor submitted a code", so the form is never blank-but-inert.
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef('');

  const attempt = useCallback(
    async (code: string): Promise<Outcome> => {
      // The access code travels in the POST body, never in the URL. [MEET-004 D5]
      const response = await fetch(`/meet/${encodeURIComponent(publicId)}/admit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(code ? { accessCode: code } : {}),
      }).catch(() => null);
      if (!response?.ok) return { kind: 'refused' };
      const body = (await response.json().catch(() => null)) as
        (MeetingAdmission & { waiting?: undefined }) | { waiting: true } | null;
      if (!body) return { kind: 'refused' };
      if ('waiting' in body && body.waiting) return { kind: 'waiting' };
      return { kind: 'admitted', admission: body as MeetingAdmission };
    },
    [publicId]
  );

  // The public id is only a locator, so try the signed-in path once on entry.
  // An invited member never has to type anything.
  useEffect(() => {
    let cancelled = false;
    void attempt('').then((result) => {
      if (cancelled) return;
      setOutcome(result.kind === 'refused' ? { kind: 'unknown' } : result);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Held in the lobby: keep asking, because admission is someone else's action.
  useEffect(() => {
    if (outcome.kind !== 'waiting') return;
    let cancelled = false;
    const timer = setInterval(() => {
      void attempt(codeRef.current).then((result) => {
        if (cancelled || result.kind === 'refused') return;
        setOutcome(result);
      });
    }, WAITING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [outcome.kind, attempt]);

  if (outcome.kind === 'admitted') {
    return (
      <MeetingCall
        admission={outcome.admission}
        onLeave={() => {
          setOutcome({ kind: 'unknown' });
          setChecking(false);
        }}
      />
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const code = accessCode.trim();
    if (!code) return;
    setChecking(true);
    setError(null);
    const result = await attempt(code);
    codeRef.current = code;
    setChecking(false);
    if (result.kind === 'refused') {
      setError(GENERIC_ERROR);
      return;
    }
    setOutcome(result);
  }

  const waiting = outcome.kind === 'waiting';

  return (
    <div className="min-h-dvh bg-background text-foreground lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(26rem,0.92fr)]">
      <MeetingLobbyHero />

      <div className="relative flex min-h-dvh items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-[25rem]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo variant="auto" size="md" textClassName="text-foreground" />
            <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-text-muted uppercase">
              Fieldbook / meet
            </span>
          </div>

          <div className="border-l-2 border-primary pl-5 sm:pl-6">
            <div className="mb-8">
              <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-accent-brand uppercase">
                Secure meeting access
              </p>
              <h1 className="mt-3 font-display text-[clamp(2rem,4vw,2.7rem)] font-semibold tracking-[-0.05em] text-foreground">
                {waiting ? 'Waiting to be let in' : 'Join the meeting'}
              </h1>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                {waiting
                  ? 'Your access code was accepted. A host will admit you shortly — keep this page open.'
                  : 'Sign in as an invited member, or enter the one-time access code from your invitation.'}
              </p>
            </div>

            {waiting ? (
              <p
                role="status"
                className="mb-5 flex items-start gap-2 border-l-2 border-accent-brand bg-muted px-4 py-3 text-sm leading-5 text-text-muted"
              >
                <Clock className="mt-0.5 size-4 shrink-0" />
                In the lobby. This page checks again every few seconds.
              </p>
            ) : (
              <form onSubmit={submit} className="space-y-4" noValidate>
                <div className="space-y-2">
                  <label
                    htmlFor="meeting-access-code"
                    className="block font-mono text-[10px] font-semibold tracking-[0.18em] text-text-strong uppercase"
                  >
                    Guest access code
                  </label>
                  <div className="relative">
                    <LockKeyhole
                      aria-hidden
                      className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
                    />
                    <input
                      id="meeting-access-code"
                      name="accessCode"
                      type="password"
                      autoComplete="one-time-code"
                      value={accessCode}
                      onChange={(event) => setAccessCode(event.target.value)}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? 'meeting-access-error' : undefined}
                      className="h-11 w-full rounded-sm border border-border bg-surface-card pr-3 pl-10 text-sm text-text-strong outline-none transition focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                    />
                  </div>
                </div>

                {error ? (
                  <p
                    id="meeting-access-error"
                    role="alert"
                    className="flex items-start gap-2 text-sm text-destructive"
                  >
                    <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                    {error}
                  </p>
                ) : null}

                <Button
                  type="submit"
                  size="lg"
                  className="h-11 w-full"
                  disabled={checking || !accessCode.trim()}
                >
                  {checking ? 'Checking access…' : 'Continue to meeting'}
                </Button>
              </form>
            )}
          </div>

          <p className="mt-8 text-xs leading-relaxed text-muted-foreground">
            Invited members are admitted automatically when signed in. Access codes are never added
            to the page address.
          </p>
        </div>
      </div>
    </div>
  );
}
