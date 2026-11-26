'use client';

import { useState } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, TRPCClientError } from '@trpc/client';
import superjson from 'superjson';
import { signInRedirectPath } from '@/lib/auth/session-state';
import { trpc } from './trpc';
import { counterApprovalHeaders } from './pharmacy/counter-offline-transport';

function getBaseUrl() {
  if (typeof window !== 'undefined') return '';
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

/**
 * #16: the server ends a revoked session with UNAUTHORIZED. Without this the
 * client would sit in a shell that silently fails every request. Send the user
 * to sign in again — the accurate remedy — instead of leaving a dead workspace
 * on screen. Uses a full navigation so the stale Auth.js session cookie and all
 * cached tenant data are dropped.
 */
function redirectOnEndedSession(error: unknown) {
  if (typeof window === 'undefined') return;
  if (!(error instanceof TRPCClientError)) return;
  if (error.data?.code !== 'UNAUTHORIZED') return;
  const target = signInRedirectPath('session-ended');
  if (window.location.pathname + window.location.search === target) return;
  window.location.assign(target);
}

/**
 * WHA-1181: React Query's default retries treated an authorization answer as a
 * transient fault. A restaurant administrator with no staff profile saw the
 * notification poll fail FORBIDDEN, then be retried twice more — three
 * identical 403s in one page load, and the same on every poll after it.
 *
 * A 4xx authorization verdict is settled server state: retrying cannot change
 * it, so surface it once and let the caller render a quiet state. UNAUTHORIZED
 * is included because `redirectOnEndedSession` above already navigates away, so
 * retrying it only races the redirect. Everything else keeps the default three
 * attempts, which is what covers a genuinely flaky network.
 */
export function retryQuery(failureCount: number, error: unknown) {
  if (error instanceof TRPCClientError) {
    const code = error.data?.code;
    if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') return false;
  }
  return failureCount < 3;
}

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: redirectOnEndedSession }),
        mutationCache: new MutationCache({ onError: redirectOnEndedSession }),
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: false,
            retry: retryQuery,
          },
        },
      })
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          headers: ({ opList }) => counterApprovalHeaders(opList),
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
