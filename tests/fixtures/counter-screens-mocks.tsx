// Synthetic transport and session for the counter screen harness (DEV-977 visual QA).
// Every name, price and batch here is made up. The harness renders the real AppShell and
// counter JSX and CSS; only the network, session and router are replaced.
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { ComponentProps } from 'react';

type Scenario = {
  name: string;
  data: Record<string, unknown>;
  search?: 'rows' | 'error';
  rows?: unknown[];
  loading?: string[];
};

declare global {
  interface Window {
    __counterScenario: Scenario;
  }
}

const scenario = () => window.__counterScenario;

type FixtureQuery = {
  data: unknown;
  status: string;
  fetchStatus: string;
  isSuccess: boolean;
  isLoading: boolean;
  isPending: boolean;
  isFetching: boolean;
  isFetched: boolean;
  isFetchedAfterMount: boolean;
  isError: boolean;
  isStale: boolean;
  isPlaceholderData: boolean;
  error: Error | null;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  refetch: () => Promise<unknown>;
};

const cache = new Map<string, FixtureQuery>();
const make = (data: unknown, state: 'ready' | 'loading' | 'error' | 'idle'): FixtureQuery => ({
  data,
  status: state === 'ready' ? 'success' : state === 'error' ? 'error' : 'pending',
  fetchStatus: state === 'loading' ? 'fetching' : 'idle',
  isSuccess: state === 'ready',
  isLoading: state === 'loading',
  isPending: state === 'loading' || state === 'idle',
  isFetching: state === 'loading',
  isFetched: state === 'ready' || state === 'error',
  isFetchedAfterMount: state === 'ready' || state === 'error',
  isError: state === 'error',
  isStale: false,
  isPlaceholderData: false,
  error: state === 'error' ? new Error('The medicine search did not answer. Try again.') : null,
  dataUpdatedAt: 1,
  errorUpdatedAt: state === 'error' ? 1 : 0,
  refetch: async () => undefined,
});

function queryFor(path: string, input: unknown, options?: { enabled?: boolean }): FixtureQuery {
  const name = path.split('.').at(-1)!;
  const key = `${path}:${JSON.stringify(input ?? null)}:${options?.enabled !== false}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const current = scenario();
  let result: FixtureQuery;
  if (current.loading?.includes(name)) result = make(undefined, 'loading');
  else if (name === 'counterSearch') {
    const text = String((input as { query?: string } | null)?.query ?? '');
    if (options?.enabled === false || text.trim().length < 2) result = make(undefined, 'idle');
    else if (current.search === 'error') result = make(undefined, 'error');
    else result = make({ rows: current.rows ?? [], truncated: false }, 'ready');
  } else if (options?.enabled === false) result = make(undefined, 'idle');
  else result = make(current.data[name], 'ready');
  cache.set(key, result);
  return result;
}

const pending = () => new Promise<never>(() => undefined);
const mutation = () => ({
  isPending: false,
  isPaused: false,
  isError: false,
  error: null,
  mutate: () => undefined,
  mutateAsync: pending,
  reset: () => undefined,
});

function procedure(path: string): unknown {
  return new Proxy(() => undefined, {
    get: (_target, prop: string) => {
      if (prop === 'useQuery' || prop === 'useSuspenseQuery')
        return (input: unknown, options?: { enabled?: boolean }) => queryFor(path, input, options);
      if (prop === 'useInfiniteQuery')
        return () => ({ ...make({ pages: [], pageParams: [] }, 'ready'), hasNextPage: false });
      if (prop === 'useMutation') return mutation;
      if (prop === 'then') return undefined;
      return procedure(`${path}.${prop}`);
    },
  });
}

const utils: unknown = new Proxy(() => Promise.resolve(undefined), {
  get: (_target, prop) => (prop === 'then' ? undefined : utils),
  apply: () => Promise.resolve(undefined),
});

export const trpc = new Proxy(
  {},
  {
    get: (_target, prop: string) => {
      if (prop === 'useUtils' || prop === 'useContext') return () => utils;
      if (prop === 'Provider') return ({ children }: { children: ReactNode }) => children;
      return procedure(prop);
    },
  }
);

const session = {
  user: {
    id: 'synthetic-user',
    organizationId: 'synthetic-org',
    status: 'ACTIVE',
    sessionRevoked: false,
    role: 'ADMIN',
    name: 'Synthetic owner',
    email: 'owner@example.invalid',
    image: null,
    isSupportSession: false,
    mustChangePassword: false,
  },
  expires: '2999-01-01T00:00:00.000Z',
};
export const useSession = () => ({
  status: 'authenticated',
  data: session,
  update: async () => session,
});
export const signIn = async () => undefined;
export const signOut = async () => undefined;
export const signOutEverything = async () => undefined;
export const SessionProvider = ({ children }: { children: ReactNode }) => children;

const entitlements = {
  organizationId: 'synthetic-org',
  vertical: 'PHARMACY',
  enabledModules: [
    'pharmacy-core',
    'pharmacy-counter',
    'pharmacy-safety',
    'pharmacy-dispensing',
    'pharmacy-inventory',
  ],
};
export const useEntitlements = () => entitlements;
export const EntitlementsProvider = ({ children }: { children: ReactNode }) => children;

const router = {
  push: () => undefined,
  replace: () => undefined,
  refresh: () => undefined,
  prefetch: () => undefined,
  back: () => undefined,
};
export const useRouter = () => router;
export const usePathname = () => '/pharmacy/counter';
export const useSearchParams = () => new URLSearchParams();
export const redirect = () => undefined;

export default function FixtureLink({
  prefetch,
  ...props
}: ComponentProps<'a'> & { prefetch?: boolean }) {
  void prefetch;
  return <a {...props} />;
}

// Theme: the harness sets data-theme on <html> before rendering.
const ThemeContext = createContext<'light' | 'dark'>('light');
const subscribe = () => () => undefined;
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    () => 'light' as const
  );
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}
export function useTheme() {
  const theme = useContext(ThemeContext);
  return useMemo(
    () => ({ theme, resolvedTheme: theme, themes: ['light', 'dark'], setTheme: () => undefined }),
    [theme]
  );
}
