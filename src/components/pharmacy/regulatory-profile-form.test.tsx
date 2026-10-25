import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyOnboarding: { regulatory: { fetch: mocks.fetch } },
    }),
    pharmacyOnboarding: {
      saveRegulatoryProfile: {
        useMutation: () => ({ isPending: false, mutate: mocks.mutate }),
      },
    },
  },
}));

import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

type Regulatory = ComponentProps<typeof PharmacyRegulatoryProfileForm>['initial'];

const regulatory = {
  branches: [
    {
      id: 'branch-a',
      name: 'Branch A',
      city: 'Lahore',
      addressLine: '12 Mall Road',
      provinceCode: 'PK-PB',
    },
    {
      id: 'branch-b',
      name: 'Branch B',
      city: 'Rawalpindi',
      addressLine: '45 Murree Road',
      provinceCode: 'PK-PB',
    },
  ],
  jurisdictions: [
    {
      id: 'rules-punjab',
      provinceCode: 'PK-PB',
      provinceName: 'Punjab',
      version: 1,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      licenceCategories: ['Retail'],
      permittedSchedules: [],
      provisional: false,
    },
  ],
  selectedBranchId: 'branch-a',
  versions: [],
} satisfies Regulatory;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockReturnValue(new Promise(() => {}));
});

afterEach(cleanup);

describe('PharmacyRegulatoryProfileForm', () => {
  it("uses the newly selected branch's premises when the form is saved", () => {
    render(<PharmacyRegulatoryProfileForm initial={regulatory} />);

    expect(screen.getByLabelText('Premises address')).toHaveValue('12 Mall Road');
    expect(screen.getByLabelText('Premises city')).toHaveValue('Lahore');

    fireEvent.change(screen.getByLabelText('Which branch is this profile for?'), {
      target: { value: 'branch-b' },
    });

    expect(screen.getByLabelText('Premises address')).toHaveValue('45 Murree Road');
    expect(screen.getByLabelText('Premises city')).toHaveValue('Rawalpindi');

    fireEvent.submit(screen.getByRole('button', { name: 'Save this version' }).closest('form')!);

    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch-b',
        premisesAddressLine: '45 Murree Road',
        premisesCity: 'Rawalpindi',
      })
    );
  });
});
