'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { trpc } from '@/lib/trpc';

type Phase = 'connecting' | 'syncing' | 'done' | 'error';

/**
 * OAuth return target for the connect popup. Reads ?code & ?state, exchanges the
 * code via the session-authenticated tRPC mutation (so the new mailbox is tied
 * to the logged-in user), then messages the opener window and closes itself.
 * The user never sees a config screen — just "Connecting" → "Syncing".
 */
function CallbackInner() {
  const params = useSearchParams();
  const [phase, setPhase] = useState<Phase>(() => (params.get('code') ? 'syncing' : 'connecting'));
  const [error, setError] = useState('');
  const firedRef = useRef(false);
  const connectCallback = trpc.email.connectCallback.useMutation();

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    const errParam = params.get('error_description') || params.get('error');
    const code = params.get('code');
    const state = params.get('state') ?? '';
    const provider = state.startsWith('OUTLOOK') ? 'OUTLOOK' : 'GMAIL';

    function finish(ok: boolean, message?: string) {
      if (ok) {
        setPhase('done');
      } else {
        setPhase('error');
        setError(message || 'Connection failed.');
      }
      try {
        window.opener?.postMessage(
          { type: 'df-email-oauth', ok, error: message },
          window.location.origin
        );
      } catch {
        // opener gone — the page still shows a status the user can close
      }
      if (ok) setTimeout(() => window.close(), 700);
    }

    if (errParam || !code) {
      finish(false, errParam || 'Consent was cancelled.');
      return;
    }
    if (!state) {
      finish(false, 'This connection link is invalid. Start the connection again from Email.');
      return;
    }

    // The server only accepts a state this signed-in session started (F11).
    connectCallback.mutate(
      { provider, code, state },
      {
        onSuccess: () => finish(true),
        onError: (e) => finish(false, e.message),
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        {phase === 'error' ? (
          <>
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <h1 className="mt-3 text-base font-semibold">Couldn’t connect</h1>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            <button
              onClick={() => window.close()}
              className="mt-5 rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted"
            >
              Close
            </button>
          </>
        ) : phase === 'done' ? (
          <>
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            </div>
            <h1 className="mt-3 text-base font-semibold">Connected</h1>
            <p className="mt-1 text-sm text-muted-foreground">You can close this window.</p>
          </>
        ) : (
          <>
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
            <h1 className="mt-3 text-base font-semibold">
              {phase === 'syncing' ? 'Syncing your inbox…' : 'Connecting…'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Hang tight, this only takes a moment.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function EmailOAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      }
    >
      <CallbackInner />
    </Suspense>
  );
}
