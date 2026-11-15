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

type Initial = Parameters<typeof PharmacyRegulatoryProfileForm>[0]['initial'];
type JurisdictionOption = Initial['jurisdictions'][number];
type VersionRow = Initial['versions'][number];

const punjabRules: JurisdictionOption = {
  id: 'pk_pb_provisional_v1',
  provinceCode: 'PK-PB',
  provinceName: 'Punjab',
  version: 1,
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  licenceCategories: [],
  permittedSchedules: [],
  provisional: true,
};

const sindhBranch: Initial = {
  branches: [
    {
      id: 'branch-sd',
      name: 'Karachi branch',
      addressLine: '4 Clifton Road',
      city: 'Karachi',
      provinceCode: 'PK-SD',
    },
  ],
  selectedBranchId: 'branch-sd',
  jurisdictions: [punjabRules],
  versions: [],
};

it("locks the province to a Sindh branch and says Sindh's rules are not published, never offering Punjab (#977)", () => {
  render(<PharmacyRegulatoryProfileForm initial={sindhBranch} />);
  const province = screen.getByLabelText('Province');
  const options = Array.from(province.querySelectorAll('option')).map((option) => ({
    value: option.value,
    text: option.textContent,
  }));
  expect(options).toEqual([{ value: 'PK-SD', text: 'Sindh (rules not published yet)' }]);
  expect(province.textContent).not.toContain('Punjab');
  expect(
    screen
      .getAllByRole('status')
      .some((notice) => notice.textContent?.startsWith('Sindh rules are not published yet.'))
  ).toBe(true);
  // The server decides by the version's effective date, so the form still
  // submits the branch's own province rather than guessing from today's rules.
  const save = screen.getByRole('button', { name: 'Save this version' });
  expect(save).toBeEnabled();
  fireEvent.submit(save.closest('form')!);
  expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ branchId: 'branch-sd', provinceCode: 'PK-SD' })
  );
});

it("submits the branch's own province, matched to its published rules (#977)", () => {
  render(
    <PharmacyRegulatoryProfileForm
      initial={{
        ...initial,
        // Stored without the country prefix, published with it.
        branches: [{ ...initial.branches[0]!, provinceCode: 'PB' }],
        jurisdictions: [
          {
            ...punjabRules,
            id: 'pk_sd_v1',
            provinceCode: 'PK-SD',
            provinceName: 'Sindh',
          },
          { ...punjabRules, provisional: false, licenceCategories: ['RETAIL'] },
        ],
      }}
    />
  );
  const province = screen.getByLabelText('Province');
  expect(Array.from(province.querySelectorAll('option')).map((o) => o.value)).toEqual(['PK-PB']);
  expect(screen.getByRole('button', { name: 'Save this version' })).toBeEnabled();
  fireEvent.submit(province.closest('form')!);
  expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ branchId: 'branch-1', provinceCode: 'PK-PB' })
  );
});

it('labels the open version that cannot operate "Not in force", not "Superseded" (#977)', () => {
  const version = {
    id: 'profile-1',
    branchId: 'branch-sd',
    version: 1,
    effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
    effectiveTo: null,
    provinceCode: 'PK-PB',
    provinceName: 'Punjab',
    licenceCategory: 'PROVISIONAL',
    licenceNumber: 'LIC-1',
    licenceValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    licenceValidTo: new Date('2030-01-01T00:00:00.000Z'),
    qualifiedPersonRegistration: 'QP-1',
    qualifiedPersonValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    qualifiedPersonValidTo: new Date('2030-01-01T00:00:00.000Z'),
    effective: true,
    inForce: false,
    licenceExpired: false,
    qualifiedPersonCoverageExpired: false,
    premisesCompletionDue: false,
  } as unknown as VersionRow;
  const closed = {
    ...version,
    id: 'profile-0',
    version: 0,
    effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
    effectiveTo: new Date('2026-11-01T00:00:00.000Z'),
    effective: false,
  } as VersionRow;
  render(
    <PharmacyRegulatoryProfileForm initial={{ ...sindhBranch, versions: [version, closed] }} />
  );
  const rows = screen.getAllByRole('row').slice(1);
  expect(rows[0]).toHaveTextContent('Not in force');
  expect(rows[0]).not.toHaveTextContent('Superseded');
  expect(rows[1]).toHaveTextContent('Superseded');
});
