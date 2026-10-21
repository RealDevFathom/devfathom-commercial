import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

const mocks = vi.hoisted(() => ({ onError: undefined as undefined | ((error: unknown) => void) }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    pharmacyOnboarding: {
      saveRegulatoryProfile: {
        useMutation: (options: { onError: (error: unknown) => void }) => {
          mocks.onError = options.onError;
          return {
            isPending: false,
            mutate: () =>
              mocks.onError?.({
                message: 'Licence valid to: The licence expiry date must be today or later.',
                data: {
                  validation: {
                    licenceValidTo: ['The licence expiry date must be today or later.'],
                  },
                },
              }),
          };
        },
      },
    },
  },
}));

const initial = {
  branches: [{ id: 'branch-a', name: 'Karachi', city: 'Karachi', provinceCode: 'PK-SD' }],
  selectedBranchId: 'branch-a',
  operationBlocked: null,
  jurisdictions: [
    {
      provinceCode: 'PK-SD',
      provinceName: 'Sindh',
      licenceCategories: ['PHARMACY'],
      permittedSchedules: [],
      provisional: false,
      pendingLegalReview: false,
    },
  ],
  versions: [
    {
      id: 'v1',
      version: 1,
      inForce: true,
      provinceCode: 'PK-SD',
      licenceNumber: 'LIC-1',
      licenceCategory: 'PHARMACY',
      licenceValidTo: new Date('2026-10-21'),
      effectiveFrom: new Date('2026-01-01'),
      effectiveTo: null,
      qualifiedPersonValidTo: new Date('2027-01-01'),
    },
  ],
};

describe('regulatory profile status and field errors', () => {
  it('shows pending legal review even when a development gate permits operation', () => {
    render(
      <PharmacyRegulatoryProfileForm
        initial={
          {
            ...initial,
            jurisdictions: [{ ...initial.jurisdictions[0], pendingLegalReview: true }],
          } as never
        }
      />
    );
    expect(screen.getAllByText('Pending legal review').length).toBeGreaterThan(0);
    expect(screen.queryByText('In force')).toBeNull();
  });
  it('shows the blocked licence state', () => {
    render(
      <PharmacyRegulatoryProfileForm
        initial={{ ...initial, operationBlocked: 'LICENCE_INVALID' } as never}
      />
    );
    expect(screen.getAllByText('Licence expired or invalid').length).toBeGreaterThan(0);
    expect(screen.queryByText('In force')).toBeNull();
  });
  it('attaches expiry validation to the licence input', () => {
    const { container } = render(<PharmacyRegulatoryProfileForm initial={initial as never} />);
    fireEvent.submit(container.querySelector('form')!);
    const input = screen.getByLabelText('Licence valid to');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('licenceValidTo-error');
    expect(container.querySelector('#licenceValidTo-error')?.textContent).toBe(
      'The licence expiry date must be today or later.'
    );
  });
});
