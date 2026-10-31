import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchRegulatory, mutate } = vi.hoisted(() => ({
  fetchRegulatory: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyOnboarding: { regulatory: { fetch: fetchRegulatory } } }),
    pharmacyOnboarding: {
      saveRegulatoryProfile: { useMutation: () => ({ mutate, isPending: false }) },
    },
  },
}));

import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

type Regulatory = ComponentProps<typeof PharmacyRegulatoryProfileForm>['initial'];
const initial: Regulatory = {
  selectedBranchId: 'branch-1',
  branches: [
    {
      id: 'branch-1',
      name: 'Karachi',
      city: 'Karachi',
      addressLine: '1 Main Road',
      provinceCode: 'PK-SD',
    },
    {
      id: 'branch-2',
      name: 'Lahore',
      city: 'Lahore',
      addressLine: '2 Main Road',
      provinceCode: 'PK-PB',
    },
  ],
  jurisdictions: [
    {
      id: 'sd',
      provinceCode: 'PK-SD',
      provinceName: 'Sindh',
      version: 1,
      effectiveFrom: new Date('2026-01-01'),
      licenceCategories: [],
      permittedSchedules: [],
      provisional: true,
    },
    {
      id: 'pb',
      provinceCode: 'PK-PB',
      provinceName: 'Punjab',
      version: 1,
      effectiveFrom: new Date('2026-01-01'),
      licenceCategories: ['RETAIL'],
      permittedSchedules: ['RX'],
      provisional: false,
    },
  ],
  versions: [],
};

beforeEach(() => vi.clearAllMocks());

describe('regulatory profile province selection', () => {
  it('shows the selected branch province and updates the notice when the province changes', () => {
    render(<PharmacyRegulatoryProfileForm initial={initial} />);
    expect(screen.getByLabelText('Province')).toHaveValue('PK-SD');
    expect(screen.getByRole('status')).toHaveTextContent('Sindh rules are pending legal review.');
    fireEvent.change(screen.getByLabelText('Province'), { target: { value: 'PK-PB' } });
    expect(screen.queryByText('Pending legal review')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Licence category')).toHaveTextContent('RETAIL');
  });

  it('supports legacy branch province codes without silently choosing another province', () => {
    render(
      <PharmacyRegulatoryProfileForm
        initial={{
          ...initial,
          branches: [{ ...initial.branches[0], provinceCode: 'PB' }],
        }}
      />
    );
    expect(screen.getByLabelText('Province')).toHaveValue('PK-PB');
    expect(screen.queryByText('Pending legal review')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Licence category')).toHaveTextContent('RETAIL');
  });

  it('requires an explicit choice if the branch province has no published rules', () => {
    render(
      <PharmacyRegulatoryProfileForm
        initial={{
          ...initial,
          branches: [{ ...initial.branches[0], provinceCode: 'PK-BA' }],
        }}
      />
    );
    expect(screen.getByLabelText('Province')).toHaveValue('');
    expect(screen.getByLabelText('Province')).toBeInvalid();
    expect(screen.queryByText('Pending legal review')).not.toBeInTheDocument();
  });

  it('prefers the effective profile province over older branch metadata', () => {
    render(
      <PharmacyRegulatoryProfileForm
        initial={{
          ...initial,
          versions: [
            {
              id: 'profile-1',
              branchId: 'branch-1',
              version: 1,
              effective: true,
              inForce: false,
              provinceCode: 'PK-PB',
              provinceName: 'Punjab',
              effectiveFrom: new Date('2026-01-01'),
              effectiveTo: null,
              licenceValidTo: new Date('2027-01-01'),
              qualifiedPersonValidTo: new Date('2027-01-01'),
            } as Regulatory['versions'][number],
          ],
        }}
      />
    );
    expect(screen.getByLabelText('Province')).toHaveValue('PK-PB');
    expect(screen.queryByText('Pending legal review')).not.toBeInTheDocument();
  });

  it('keeps the effective profile warning when newer rules or the draft province are confirmed', () => {
    render(
      <PharmacyRegulatoryProfileForm
        initial={{
          ...initial,
          jurisdictions: initial.jurisdictions.map((jurisdiction) => ({
            ...jurisdiction,
            provisional: false,
          })),
          versions: [
            {
              id: 'profile-1',
              version: 1,
              effective: true,
              inForce: false,
              pendingLegalReview: true,
              provinceCode: 'PK-SD',
              provinceName: 'Sindh',
              effectiveFrom: new Date('2026-01-01'),
              effectiveTo: null,
              licenceValidTo: new Date('2027-01-01'),
              qualifiedPersonValidTo: new Date('2027-01-01'),
            } as Regulatory['versions'][number],
          ],
        }}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Sindh rules are pending legal review.');
    fireEvent.change(screen.getByLabelText('Province'), { target: { value: 'PK-PB' } });
    expect(screen.getByRole('status')).toHaveTextContent('Sindh rules are pending legal review.');
  });

  it('distinguishes provisional draft rules from a confirmed profile in force', () => {
    render(
      <PharmacyRegulatoryProfileForm
        initial={{
          ...initial,
          versions: [
            {
              id: 'profile-1',
              version: 1,
              effective: true,
              inForce: true,
              pendingLegalReview: false,
              provinceCode: 'PK-SD',
              provinceName: 'Sindh',
              effectiveFrom: new Date('2026-01-01'),
              effectiveTo: null,
              licenceValidTo: new Date('2027-01-01'),
              qualifiedPersonValidTo: new Date('2027-01-01'),
            } as Regulatory['versions'][number],
          ],
        }}
      />
    );

    expect(screen.getAllByText('In force')[0]).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sindh rules for the new version are pending legal review.'
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(
      'dispensing and activation remain blocked'
    );
    fireEvent.change(screen.getByLabelText('Province'), { target: { value: 'PK-PB' } });
    expect(screen.queryByText('Pending legal review')).not.toBeInTheDocument();
  });

  it('refreshes the province on branch changes and ignores an obsolete branch response', async () => {
    let resolveOld!: (data: Regulatory) => void;
    fetchRegulatory.mockReturnValueOnce(
      new Promise<Regulatory>((resolve) => {
        resolveOld = resolve;
      })
    );
    fetchRegulatory.mockResolvedValueOnce(initial);
    render(<PharmacyRegulatoryProfileForm initial={initial} />);
    const branch = screen.getByLabelText('Which branch is this profile for?');
    fireEvent.change(branch, { target: { value: 'branch-2' } });
    fireEvent.change(branch, { target: { value: 'branch-1' } });
    await waitFor(() => expect(fetchRegulatory).toHaveBeenCalledTimes(2));
    await act(async () => resolveOld({ ...initial, selectedBranchId: 'branch-2' }));
    expect(branch).toHaveValue('branch-1');
    expect(screen.getByLabelText('Province')).toHaveValue('PK-SD');
    expect(screen.getByRole('status')).toHaveTextContent('Sindh rules are pending legal review.');

    fetchRegulatory.mockResolvedValueOnce({ ...initial, selectedBranchId: 'branch-2' });
    fireEvent.change(branch, { target: { value: 'branch-2' } });
    await waitFor(() => expect(screen.getByLabelText('Province')).toHaveValue('PK-PB'));
    expect(screen.queryByText('Pending legal review')).not.toBeInTheDocument();
  });
});
