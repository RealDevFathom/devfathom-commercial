import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type SaveError = {
  data: { validation: Record<string, string[]> };
  message: string;
};

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  fetch: vi.fn(),
  onError: undefined as ((error: SaveError) => void) | undefined,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyOnboarding: { regulatory: { fetch: mocks.fetch } } }),
    pharmacyOnboarding: {
      saveRegulatoryProfile: {
        useMutation: (options: { onError: (error: SaveError) => void }) => {
          mocks.onError = options.onError;
          return { mutate: mocks.mutate, isPending: false };
        },
      },
    },
  },
}));

import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

const initial: Parameters<typeof PharmacyRegulatoryProfileForm>[0]['initial'] = {
  branches: [
    {
      id: 'branch-1',
      name: 'Main pharmacy',
      addressLine: '12 Mall Road',
      city: 'Lahore',
      provinceCode: 'PK-PB',
    },
  ],
  selectedBranchId: 'branch-1',
  jurisdictions: [],
  versions: [],
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('sends the configured pharmacy phone to the supported profile save procedure', () => {
  render(<PharmacyRegulatoryProfileForm initial={initial} />);
  const phone = screen.getByLabelText('Pharmacy phone (optional)');
  expect(phone).toHaveAttribute('type', 'tel');
  expect(phone).toHaveAttribute('maxlength', '60');
  fireEvent.change(phone, { target: { value: '  +92 (42) 123-4567  ' } });
  fireEvent.submit(phone.closest('form')!);
  expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      branchId: 'branch-1',
      premisesPhone: '+92 (42) 123-4567',
    })
  );
});

it('preserves the entered phone and focuses its field when the server rejects it', () => {
  render(<PharmacyRegulatoryProfileForm initial={initial} />);
  const phone = screen.getByLabelText('Pharmacy phone (optional)');
  fireEvent.change(phone, { target: { value: '042-1234567' } });
  act(() =>
    mocks.onError!({
      data: { validation: { premisesPhone: ['A phone number is at most 60 characters.'] } },
      message: 'Invalid profile',
    })
  );
  expect(phone).toHaveValue('042-1234567');
  expect(phone).toHaveFocus();
  expect(phone).toHaveAttribute('aria-invalid', 'true');
  expect(phone).toHaveAttribute('aria-describedby', 'premisesPhone-error');
  expect(screen.getByRole('alert')).toHaveTextContent('A phone number is at most 60 characters.');
});

it("replaces the previous branch's premises with the selected branch's and saves those", () => {
  const twoBranches = {
    ...initial,
    branches: [
      ...initial.branches,
      {
        id: 'branch-2',
        name: 'Gulberg pharmacy',
        addressLine: '7 Main Boulevard',
        city: 'Faisalabad',
        provinceCode: 'PK-PB',
      },
    ],
  };
  mocks.fetch.mockReturnValue(new Promise(() => {}));
  render(<PharmacyRegulatoryProfileForm initial={twoBranches} />);
  expect(screen.getByLabelText('Premises address')).toHaveValue('12 Mall Road');
  expect(screen.getByLabelText('Premises city')).toHaveValue('Lahore');

  fireEvent.change(screen.getByLabelText('Which branch is this profile for?'), {
    target: { value: 'branch-2' },
  });

  const address = screen.getByLabelText('Premises address');
  expect(address).toHaveValue('7 Main Boulevard');
  expect(screen.getByLabelText('Premises city')).toHaveValue('Faisalabad');
  fireEvent.submit(address.closest('form')!);
  expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      branchId: 'branch-2',
      premisesAddressLine: '7 Main Boulevard',
      premisesCity: 'Faisalabad',
    })
  );
});
