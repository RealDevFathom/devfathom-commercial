import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';

import { trpc } from '@/lib/trpc';
import { RestaurantDashboardContent } from './restaurant-dashboard-content';

const preference = {
  version: 1,
  defaultBranchId: 'branch_1',
  rangeDays: 7,
  widgets: [
    { key: 'performance', visible: true, span: 'wide' },
    { key: 'trend', visible: true, span: 'wide' },
    { key: 'exceptions', visible: true, span: 'compact' },
    { key: 'itemMix', visible: true, span: 'compact' },
    { key: 'labour', visible: true, span: 'wide' },
  ],
};

function success(data: unknown) {
  return { result: { data: superjson.serialize(data) } };
}

function unavailable(path: string) {
  return {
    error: {
      json: {
        message: 'Service unavailable',
        code: -32603,
        data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 503, path },
      },
    },
  };
}

function resultFor(path: string) {
  if (path === 'restaurantDashboard.getPreferences') return success(preference);
  if (path === 'restaurantStaff.listBranches') {
    return success([{ id: 'branch_1', name: 'Main', active: true, isDefault: true }]);
  }
  if (path.startsWith('restaurantInsights.')) return unavailable(path);
  throw new Error(`Unexpected tRPC operation: ${path}`);
}

function Providers({ children, fetch }: { children: ReactNode; fetch: typeof globalThis.fetch }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({ url: 'http://dashboard.test/api/trpc', transformer: superjson, fetch }),
    ],
  });
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

describe('RestaurantManagementOverview tRPC transitions', () => {
  it('replaces loading with five recovery states after the first insight HTTP 503 batch', async () => {
    let releaseAnalytics!: () => void;
    const analyticsResponse = new Promise<void>((resolve) => {
      releaseAnalytics = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      const paths = url.pathname.split('/').at(-1)!.split(',');
      if (paths.some((path) => path.startsWith('restaurantInsights.'))) await analyticsResponse;
      const body = paths.map(resultFor);
      const status = paths.some((path) => path.startsWith('restaurantInsights.')) ? 503 : 200;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });

    render(
      <Providers fetch={fetch}>
        <RestaurantDashboardContent enabledModules={['restaurant-core', 'restaurant-insights']} />
      </Providers>
    );

    expect(
      await screen.findByRole('status', { name: 'Loading reconciled performance rollups' })
    ).toBeVisible();
    releaseAnalytics();

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(5), { timeout: 750 });
    for (const alert of screen.getAllByRole('alert')) {
      expect(alert).toHaveAccessibleName(/unavailable/i);
      expect(alert).toHaveTextContent(/could not be loaded/i);
      expect(alert).toHaveTextContent('No cached figures are shown.');
      expect(alert).not.toBeEmptyDOMElement();
    }
    const retries = screen.getAllByRole('button', { name: 'Retry' });
    expect(retries).toHaveLength(5);
    expect(screen.getByRole('heading', { level: 2, name: 'Quick access' })).toBeVisible();
    const requestsBeforeRetry = fetch.mock.calls.length;
    fireEvent.click(retries[0]!);
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(requestsBeforeRetry));
  });
});
