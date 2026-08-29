import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PAKISTAN_TAX_PROFILE_CATALOG } from '@/lib/restaurant/pakistan-tax-profiles';

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), invalidate: vi.fn() }));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantTax: { configuration: { invalidate: mocks.invalidate } } }),
    restaurantTax: {
      configuration: {
        useQuery: () => ({
          data: {
            branches: [{ id: 'branch_1', name: 'Karachi' }],
            profiles: PAKISTAN_TAX_PROFILE_CATALOG,
            activeProfiles: [],
          },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
      activate: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
    },
  },
}));

import { RestaurantTaxConsole } from './restaurant-tax-console';

describe('restaurant tax configuration UI', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an unconfigured fail-closed state and disables unverified presets', () => {
    render(<RestaurantTaxConsole />);
    expect(screen.getByText('No tax profile configured.')).toBeInTheDocument();
    expect(screen.getByText(/checkout remains fail-closed/i)).toBeInTheDocument();
    const punjab = screen.getByRole('option', { name: /Punjab restaurant \(unavailable\)/i });
    expect(punjab).toBeDisabled();
    expect(
      screen.getByRole('option', {
        name: /Sindh restaurant — SRB-approved listed branch \(unavailable\)/i,
      })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Activate tax profile' })).toBeDisabled();
  });

  it('submits explicit branch, profile, date, approval, and eligibility evidence', () => {
    render(<RestaurantTaxConsole />);
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    fireEvent.change(screen.getByLabelText('Jurisdiction and profile'), {
      target: { value: 'PK-ICT-RESTAURANT' },
    });
    fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('Accountant approval reference'), {
      target: { value: 'Memo 42' },
    });
    for (const label of [
      /no input tax credit or adjustment/i,
      /no refund/i,
      /I confirm an accountant reviewed/i,
    ])
      fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByRole('button', { name: 'Activate tax profile' }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      branchId: 'branch_1',
      profileId: 'PK-ICT-RESTAURANT',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      approvalReference: 'Memo 42',
      accountantConfirmation: true,
      eligibilityConfirmations: ['ictNoInputTaxCreditOrAdjustment', 'ictNoRefund'],
      idempotencyKey: expect.any(String),
    });
  });
});
