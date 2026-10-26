import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyOnboarding: { regulatory: { fetch: vi.fn() } } }),
    pharmacyOnboarding: {
      saveRegulatoryProfile: {
        useMutation: () => ({ mutate: vi.fn() }),
      },
    },
  },
}));

import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

describe('pharmacy regulatory profile form', () => {
  it('labels Sindh as pending legal review and explains the production restriction', () => {
    render(
      <PharmacyRegulatoryProfileForm
        initial={
          {
            branches: [
              {
                id: 'branch-1',
                name: 'Clifton',
                city: 'Karachi',
                addressLine: '1 Sea View Road',
                provinceCode: 'SD',
              },
            ],
            jurisdictions: [
              {
                id: 'pk_sd_pending_legal_review_v2',
                provinceCode: 'PK-SD',
                provinceName: 'Sindh',
                version: 2,
                effectiveFrom: new Date('2026-10-24T00:00:00.000Z'),
                licenceCategories: ['RETAIL'],
                permittedSchedules: ['G', 'H'],
                provisional: false,
                pendingLegalReview: true,
              },
              {
                id: 'pk_pb_provisional_v1',
                provinceCode: 'PK-PB',
                provinceName: 'Punjab',
                version: 1,
                effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
                licenceCategories: [],
                permittedSchedules: [],
                provisional: true,
                pendingLegalReview: false,
              },
            ],
            selectedBranchId: 'branch-1',
            versions: [],
          } as never
        }
      />
    );

    expect(
      screen.getByRole('option', { name: 'Sindh (pending legal review)' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not legally confirmed.*cannot operate.*production/i)
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Province'), { target: { value: 'PK-PB' } });
    expect(screen.getByText(/rules are still provisional/i)).toBeInTheDocument();
  });
});
