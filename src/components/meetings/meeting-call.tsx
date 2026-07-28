'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2, Video, AlertTriangle } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useBreadcrumbLabel } from '@/lib/breadcrumb-store';

const JAAS_APP_ID = process.env.NEXT_PUBLIC_JAAS_APP_ID;

// Minimal surface of the JaaS external API we use. The real lib ships no types.
type JitsiMeetExternalApi = {
  addListener: (event: string, listener: (...args: unknown[]) => void) => void;
  executeCommand: (command: string, ...args: unknown[]) => void;
  dispose: () => void;
};

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options: Record<string, unknown>
    ) => JitsiMeetExternalApi;
  }
}

// Module-level cache so external_api.js is only injected once per page session,
// even across remounts (React StrictMode double-invokes effects in dev).
let externalApiPromise: Promise<void> | null = null;

function loadExternalApi(appId: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  if (externalApiPromise) return externalApiPromise;

  externalApiPromise = new Promise<void>((resolve, reject) => {
    const src = `https://8x8.vc/${appId}/external_api.js`;
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (window.JitsiMeetExternalAPI) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('script error')));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Allow a later retry by clearing the cached (rejected) promise.
      externalApiPromise = null;
      reject(new Error('Failed to load the video calling library.'));
    };
    document.body.appendChild(script);
  });

  return externalApiPromise;
}

export function MeetingCall({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<JitsiMeetExternalApi | null>(null);
  // RT-03: track whether we're actually in the call so we only stamp leftAt when
  // leaving an active session (SPA nav / tab close), not on a failed connect.
  const joinedRef = useRef(false);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // react-query mutate fns are referentially stable, so listing them keeps the
  // effect from re-running while satisfying exhaustive-deps.
  const utils = trpc.useUtils();
  const { mutateAsync: getCallToken } = trpc.meetings.getCallToken.useMutation();
  const { mutate: logJoin } = trpc.meetings.logJoin.useMutation();
  const { mutate: logLeave } = trpc.meetings.logLeave.useMutation();

  // Resolve the real meeting title so the breadcrumb, page header, and the
  // in-call Jitsi subject show "Sprint Planning" instead of the raw room id.
  const { data: meeting } = trpc.meetings.getById.useQuery({ id: meetingId });
  const title = meeting?.title;
  useBreadcrumbLabel(meetingId, title);
  // Kept in a ref so the (once-only) call-init effect can read the latest title
  // without taking it as a dependency.
  const titleRef = useRef<string | undefined>(undefined);

  // If the title resolves after the conference is already up, push it as the subject.
  useEffect(() => {
    titleRef.current = title;
    if (title) apiRef.current?.executeCommand('subject', title);
  }, [title]);

  useEffect(() => {
    let cancelled = false;

    // RT-03: on a hard unload (tab close / refresh / external nav) the React
    // cleanup does NOT run, so stamp leftAt with a keepalive request that can
    // outlive the page. SPA navigation is handled by the cleanup below.
    const beaconLeave = () => {
      try {
        fetch('/api/trpc/meetings.logLeave?batch=1', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ 0: { json: { meetingId } } }),
          keepalive: true,
          credentials: 'include',
        }).catch(() => {});
      } catch {
        // best-effort only
      }
    };
    const onPageHide = () => {
      if (joinedRef.current) {
        joinedRef.current = false;
        beaconLeave();
      }
    };
    window.addEventListener('pagehide', onPageHide);

    (async () => {
      try {
        if (!JAAS_APP_ID) throw new Error('Video calling is not configured.');

        // Fetch the token and the meeting (for its title) together. The title
        // must be known BEFORE construction so the Jitsi prejoin screen shows it
        // as the subject rather than the humanized room id.
        const [{ jwt, roomName }, meetingData] = await Promise.all([
          getCallToken({ meetingId }),
          utils.meetings.getById.fetch({ id: meetingId }).catch(() => null),
        ]);
        const subject = meetingData?.title;
        await loadExternalApi(JAAS_APP_ID);
        if (cancelled || !containerRef.current || !window.JitsiMeetExternalAPI) return;

        const api = new window.JitsiMeetExternalAPI('8x8.vc', {
          roomName,
          jwt,
          parentNode: containerRef.current,
          width: '100%',
          height: '100%',
          ...(subject ? { configOverwrite: { subject } } : {}),
        });
        apiRef.current = api;
        setConnecting(false);

        const handleLeave = () => {
          joinedRef.current = false;
          logLeave({ meetingId });
          apiRef.current?.dispose();
          apiRef.current = null;
          router.push('/meetings');
        };

        api.addListener('videoConferenceJoined', () => {
          joinedRef.current = true;
          logJoin({ meetingId });
          if (titleRef.current) api.executeCommand('subject', titleRef.current);
        });
        api.addListener('videoConferenceLeft', handleLeave);
        api.addListener('readyToClose', handleLeave);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not start the call.');
          setConnecting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onPageHide);
      // RT-03: SPA navigation unmounts this component — stamp leftAt if still in
      // the call (logLeave is a no-op-safe updateMany, so a double-fire is fine).
      if (joinedRef.current) {
        joinedRef.current = false;
        logLeave({ meetingId });
      }
      apiRef.current?.dispose();
      apiRef.current = null;
    };
  }, [meetingId, router, utils, getCallToken, logJoin, logLeave]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border border-border bg-card">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
        <Link
          href="/meetings"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          title="Back to meetings"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
            <Video className="h-3.5 w-3.5 text-primary" />
          </div>
          <span className="text-sm font-semibold text-foreground">{title ?? 'Meeting call'}</span>
        </div>
      </div>

      {/* Call surface */}
      <div className="relative flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {connecting && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Connecting to the call…</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
              <AlertTriangle className="h-6 w-6 text-red-500" />
            </div>
            <p className="text-sm font-medium text-foreground">{error}</p>
            <Link
              href="/meetings"
              className="mt-1 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#0C2E2C]"
            >
              Back to meetings
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
