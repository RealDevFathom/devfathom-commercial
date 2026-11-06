/**
 * DEV-751 — a stand-in for `@/lib/trpc` in the pharmacy procedure UI tests.
 * Use it with `vi.mock('@/lib/trpc', async () => (await import('./sop-trpc-mock')).trpcModule)`
 * and drive it through `mockState`: queries answer from `queries`, mutations
 * from `outcomes` (return an Error to refuse), and every call, refetch and
 * invalidation is recorded.
 */
import { vi } from 'vitest';

type QueryValue = { data?: unknown; error?: unknown; loading?: boolean };
type MutationOptions = {
  onSuccess?: (result: unknown, variables?: unknown) => unknown;
  onError?: (error: unknown) => unknown;
};

export const mockState = {
  queries: {} as Record<string, QueryValue | ((input: unknown) => QueryValue)>,
  outcomes: {} as Record<string, (input: unknown) => unknown>,
  calls: {} as Record<string, unknown[]>,
  invalidated: [] as Array<[string, unknown]>,
  reset() {
    this.queries = {};
    this.outcomes = {};
    this.calls = {};
    this.invalidated = [];
  },
};

function answer(name: string, input: unknown): QueryValue {
  const entry = mockState.queries[name];
  return typeof entry === 'function' ? entry(input) : (entry ?? {});
}

const procedure = (name: string) => ({
  useQuery: (input: unknown, options?: { enabled?: boolean }) => {
    if (options?.enabled === false) {
      return { data: undefined, error: null, isLoading: false, refetch: vi.fn() };
    }
    const value = answer(name, input);
    return {
      data: value.data,
      error: value.error ?? null,
      isLoading: Boolean(value.loading),
      refetch: vi.fn(async () => ({ data: answer(name, input).data })),
    };
  },
  useMutation: (options?: MutationOptions) => ({
    isPending: false,
    isSuccess: false,
    variables: undefined,
    mutate: (input: unknown, call?: MutationOptions) => {
      (mockState.calls[name] ??= []).push(input);
      const result = mockState.outcomes[name]?.(input) ?? {};
      if (result instanceof Error) {
        options?.onError?.(result);
        call?.onError?.(result);
      } else {
        options?.onSuccess?.(result, input);
        call?.onSuccess?.(result, input);
      }
    },
  }),
});

export const trpcModule = {
  trpc: {
    pharmacySop: new Proxy({}, { get: (_target, name: string) => procedure(name) }),
    useUtils: () => ({
      pharmacySop: new Proxy(
        {},
        {
          get: (_target, name: string) => ({
            invalidate: vi.fn(async (input?: unknown) => {
              mockState.invalidated.push([name, input]);
            }),
          }),
        }
      ),
    }),
  },
};

/** A tRPC refusal as the client sees it. */
export function refusal(message: string, code: string) {
  return Object.assign(new Error(message), { data: { code } });
}
