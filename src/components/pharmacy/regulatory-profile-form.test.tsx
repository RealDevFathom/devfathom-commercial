import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyOnboarding: {
        regulatory: { fetch: vi.fn(() => new Promise(() => undefined)) },
      },
    }),
    pharmacyOnboarding: {
      saveRegulatoryProfile: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
    },
  },
}));

describe('PharmacyRegulatoryProfileForm', () => {
  it("replaces the premises fields with the selected branch's address", () => {
    render(
      <PharmacyRegulatoryProfileForm
        initial={
          {
            selectedBranchId: 'branch-a',
            branches: [
              {
                id: 'branch-a',
                name: 'Branch A',
                addressLine: '12 Mall Road',
                city: 'Lahore',
              },
              {
                id: 'branch-b',
                name: 'Branch B',
                addressLine: '44 Club Road',
                city: 'Karachi',
              },
            ],
            jurisdictions: [],
            versions: [],
          } as never
        }
      />
    );

    const address = screen.getByLabelText('Premises address');
    const city = screen.getByLabelText('Premises city');
    fireEvent.change(address, { target: { value: 'Unsaved branch A address' } });
    fireEvent.change(city, { target: { value: 'Unsaved branch A city' } });

    fireEvent.change(screen.getByLabelText('Which branch is this profile for?'), {
      target: { value: 'branch-b' },
    });

    expect(screen.getByLabelText('Premises address')).toHaveValue('44 Club Road');
    expect(screen.getByLabelText('Premises city')).toHaveValue('Karachi');
  });
});
