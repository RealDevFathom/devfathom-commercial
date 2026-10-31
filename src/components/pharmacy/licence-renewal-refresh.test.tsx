import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { planRenewalReminders } from '@/lib/pharmacy/licence-renewal';
import { trpc } from '@/lib/trpc';
import { LicenceRenewalBanner } from './licence-renewal-banner';
import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

const initial: ComponentProps<typeof PharmacyRegulatoryProfileForm>['initial'] = {
  branches: [
    { id: 'b1', name: 'Main', city: 'Lahore', addressLine: 'Main Road', provinceCode: 'PK-PB' },
  ],
  jurisdictions: [],
  selectedBranchId: 'b1',
  versions: [],
};
const reminders = planRenewalReminders(
  [
    {
      kind: 'BRANCH_LICENCE',
      branchId: 'b1',
      subjectId: 'b1',
      label: 'Main branch licence',
      reference: 'LIC-1',
      expiresAt: new Date('2026-10-04T00:00:00Z'),
      provinceCode: 'PK-PB',
      licenceCategory: 'PHARMACY',
    },
  ],
  new Date('2026-09-04T00:00:00Z')
);

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

function harness() {
  // Match the shared provider: reminders are fresh for 60 seconds and focus does not refetch.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: false },
    },
  });
  clients.push(queryClient);
  let renewed = false;
  const requests: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const path = new URL(String(input)).pathname.split('/').at(-1)!;
    requests.push(path);
    let data: unknown;
    if (path === 'pharmacyReports.licenceRenewals') {
      data = { reminders: renewed ? [] : reminders };
    } else if (path === 'pharmacyOnboarding.saveRegulatoryProfile') {
      renewed = true;
      data = { version: 2, readiness: { items: [] } };
    } else if (path === 'pharmacyOnboarding.regulatory') {
      data = initial;
    } else {
      throw new Error(`Unexpected tRPC operation: ${path}`);
    }
    return new Response(JSON.stringify({ result: { data: superjson.serialize(data) } }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = trpc.createClient({
    links: [httpLink({ url: 'http://renewal.test/api/trpc', transformer: superjson, fetch })],
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    );
  }
  const renewalReads = () =>
    requests.filter((path) => path === 'pharmacyReports.licenceRenewals').length;
  return {
    queryClient,
    Wrapper,
    renewalReads,
    renew: () => {
      renewed = true;
    },
  };
}

describe('licence renewal cache refresh', () => {
  it.each([undefined, 'b1'])(
    'clears reminders after saving and returning to scope %s',
    async (branchId) => {
      const { queryClient, Wrapper, renewalReads } = harness();
      const keys = [{}, { branchId: 'b1' }, { branchId: 'b2' }].map((input) =>
        getQueryKey(trpc.pharmacyReports.licenceRenewals, input, 'query')
      );
      for (const key of keys) queryClient.setQueryData(key, { reminders });
      const view = render(<LicenceRenewalBanner branchId={branchId} />, { wrapper: Wrapper });
      expect(await screen.findByTestId('licence-renewal-banner')).toBeVisible();
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));

      view.rerender(<PharmacyRegulatoryProfileForm initial={initial} />);
      fireEvent.click(screen.getByRole('button', { name: 'Save this version' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Version 2 saved');
      // Invalidate all variants, including inactive caches for other dashboard scopes.
      for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);

      const readsBeforeReturn = renewalReads();
      view.rerender(<LicenceRenewalBanner branchId={branchId} />);
      await waitFor(() => expect(renewalReads()).toBeGreaterThan(readsBeforeReturn));
      await waitFor(() =>
        expect(screen.queryByTestId('licence-renewal-banner')).not.toBeInTheDocument()
      );
    }
  );

  it('rechecks fresh reminders on return when renewal was recorded elsewhere', async () => {
    const { queryClient, Wrapper, renewalReads, renew } = harness();
    const view = render(<LicenceRenewalBanner />, { wrapper: Wrapper });
    expect(await screen.findByTestId('licence-renewal-banner')).toBeVisible();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const key = getQueryKey(trpc.pharmacyReports.licenceRenewals, {}, 'query');
    expect(Date.now() - queryClient.getQueryState(key)!.dataUpdatedAt).toBeLessThan(60_000);

    view.rerender(<div>Supplier or regulatory profile</div>);
    renew();
    view.rerender(<LicenceRenewalBanner />);
    await waitFor(() => expect(renewalReads()).toBe(2));
    await waitFor(() =>
      expect(screen.queryByTestId('licence-renewal-banner')).not.toBeInTheDocument()
    );
  });
});
