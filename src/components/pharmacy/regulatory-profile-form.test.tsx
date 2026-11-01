import { cleanup, render, screen } from '@testing-library/react';
import type { inferRouterOutputs } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppRouter } from '@/server/routers/_app';

type Regulatory = inferRouterOutputs<AppRouter>['pharmacyOnboarding']['regulatory'];

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(() => Promise.resolve({})),
  mutation: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyOnboarding: { regulatory: { fetch: mocks.fetch } },
    }),
    pharmacyOnboarding: {
      saveRegulatoryProfile: { useMutation: () => mocks.mutation },
    },
  },
}));

import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

afterEach(cleanup);

/**
 * A minimal `regulatory` output with one effective-dated version. Only the
 * fields the form and its history table read are populated; the cast keeps the
 * fixture small without re-deriving the whole router-output type.
 */
const initial = {
  branches: [
    {
      id: 'branch_1',
      name: 'Mall Road',
      city: 'Lahore',
      addressLine: '12 Mall Road',
      provinceCode: 'PK-PB',
    },
  ],
  jurisdictions: [
    {
      provinceCode: 'PK-PB',
      provinceName: 'Punjab',
      licenceCategories: ['RETAIL'],
      permittedSchedules: ['G'],
      provisional: false,
    },
  ],
  selectedBranchId: 'branch_1',
  versions: [
    {
      id: 'version_1',
      version: 1,
      effectiveFrom: '2026-09-02T00:00:00.000Z',
      effectiveTo: null,
      provinceCode: 'PK-PB',
      provinceName: 'Punjab',
      licenceCategory: 'RETAIL',
      licenceNumber: 'LIC-4471',
      licenceValidFrom: '2026-01-01T00:00:00.000Z',
      licenceValidTo: '2027-01-01T00:00:00.000Z',
      qualifiedPersonRegistration: 'PC-9981',
      qualifiedPersonValidFrom: '2026-01-01T00:00:00.000Z',
      qualifiedPersonValidTo: '2027-01-01T00:00:00.000Z',
      inForce: true,
    },
  ],
} as unknown as Regulatory;

describe('PharmacyRegulatoryProfileForm version history', () => {
  it('exposes the horizontal version-history scroll as a keyboard-reachable region', () => {
    render(<PharmacyRegulatoryProfileForm initial={initial} />);

    const region = screen.getByRole('region', { name: 'Effective-dated versions' });

    expect(region).toHaveClass('overflow-x-auto');
    // tabIndex 0 is what makes the overflowing table scrollable from the
    // keyboard at 390px, where `min-w-[40rem]` forces horizontal overflow.
    expect(region.tabIndex).toBe(0);
  });
});
