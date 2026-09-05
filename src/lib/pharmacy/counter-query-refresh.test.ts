import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { refreshCounterQueries } from './counter-query-refresh';

type Cart = { lines: string[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('counter post-mutation refresh', () => {
  it.each(['before', 'after'] as const)(
    'keeps committed lines when initial empty read resolves %s the fresh read',
    async (order) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      });
      const initial = deferred<Cart>();
      const fresh = deferred<Cart>();
      const started = deferred<void>();
      const queryKey = ['pharmacySales', 'counterCart', { branchId: 'branch', saleId: 'sale' }];
      const queryFn = vi
        .fn()
        .mockImplementationOnce(() => initial.promise)
        .mockImplementationOnce(() => {
          started.resolve();
          return fresh.promise;
        });
      const observer = new QueryObserver(client, { queryKey, queryFn });
      const unsubscribe = observer.subscribe(() => {});
      const receipt = vi.fn(async () => {});
      try {
        expect(queryFn).toHaveBeenCalledTimes(1);
        // addLine has committed; the initial request still holds an empty snapshot.
        const refreshing = refreshCounterQueries({
          counterCart: {
            cancel: () => client.cancelQueries({ queryKey }),
            invalidate: () => client.invalidateQueries({ queryKey }),
          },
          counterReceipt: { invalidate: receipt },
        });
        await started.promise;
        expect(receipt).not.toHaveBeenCalled();
        if (order === 'before') {
          initial.resolve({ lines: [] });
          await initial.promise;
        }
        fresh.resolve({ lines: ['persisted-rx-line'] });
        await refreshing;
        if (order === 'after') {
          initial.resolve({ lines: [] });
          await initial.promise;
        }
        expect(queryFn).toHaveBeenCalledTimes(2);
        expect(observer.getCurrentResult().data).toEqual({ lines: ['persisted-rx-line'] });
        expect(client.getQueryData(queryKey)).toEqual({ lines: ['persisted-rx-line'] });
        expect(receipt).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
        client.clear();
      }
    }
  );

  it('refreshes an already settled cart', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const queryKey = ['pharmacySales', 'counterCart'];
    client.setQueryData(queryKey, { lines: [] });
    const queryFn = vi.fn(async () => ({ lines: ['persisted-rx-line'] }));
    const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await refreshCounterQueries({
        counterCart: {
          cancel: () => client.cancelQueries({ queryKey }),
          invalidate: () => client.invalidateQueries({ queryKey }),
        },
        counterReceipt: { invalidate: async () => {} },
      });
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(observer.getCurrentResult().data).toEqual({ lines: ['persisted-rx-line'] });
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
