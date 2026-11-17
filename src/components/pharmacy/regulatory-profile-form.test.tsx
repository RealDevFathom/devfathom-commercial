import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SaveError = {
  data: { validation: Record<string, string[]> };
  message: string;
};

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  fetch: vi.fn(),
  onError: undefined as ((error: SaveError) => void) | undefined,
  provinceMutate: vi.fn(),
  provinceOnSuccess: undefined as
    ((result: { branchId: string; provinceCode: string; changed: boolean }) => void) | undefined,
  provinceOnError: undefined as ((error: SaveError) => void) | undefined,
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
      setBranchProvince: {
        useMutation: (options: {
          onSuccess: NonNullable<typeof mocks.provinceOnSuccess>;
          onError: (error: SaveError) => void;
        }) => {
          mocks.provinceOnSuccess = options.onSuccess;
          mocks.provinceOnError = options.onError;
          return { mutate: mocks.provinceMutate, isPending: false };
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

it("blames DevFathom's unreviewed rule config, not the province, when categories and schedules are empty (#1237)", () => {
  const { container } = render(<PharmacyRegulatoryProfileForm initial={initial} />);
  const text = container.textContent ?? '';
  expect(text).toContain("DevFathom's licence category list for this province is unreviewed");
  expect(text).toContain("DevFathom's schedule list for this province is unreviewed");
  expect(text).toContain('operating gate stays in place');
  expect(text).not.toContain('This province has not published');
});

describe('branch province (QA-3)', () => {
  it('offers every province, preselects the branch’s own, and saves only a change', () => {
    mocks.fetch.mockResolvedValue(initial);
    render(<PharmacyRegulatoryProfileForm initial={initial} />);
    const picker = screen.getByLabelText('Province this branch operates in');
    expect(picker).toHaveValue('PK-PB');
    expect(Array.from(picker.querySelectorAll('option')).map((o) => o.textContent)).toContain(
      'Sindh'
    );
    const save = screen.getByRole('button', { name: 'Save province' });
    expect(save).toBeDisabled();
    fireEvent.change(picker, { target: { value: 'PK-SD' } });
    expect(save).toBeEnabled();
    fireEvent.submit(save.closest('form')!);
    expect(mocks.provinceMutate).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-1',
      provinceCode: 'PK-SD',
    });
    // The regulatory profile save is a separate action.
    expect(mocks.mutate).not.toHaveBeenCalled();
    act(() =>
      mocks.provinceOnSuccess!({ branchId: 'branch-1', provinceCode: 'PK-SD', changed: true })
    );
    expect(
      screen
        .getAllByRole('status')
        .some((notice) => notice.textContent === 'Main pharmacy now operates in Sindh.')
    ).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledWith({ branchId: 'branch-1' });
  });

  it('shows a refused change on the province picker', () => {
    render(<PharmacyRegulatoryProfileForm initial={initial} />);
    const picker = screen.getByLabelText('Province this branch operates in');
    fireEvent.change(picker, { target: { value: 'PK-KP' } });
    act(() =>
      mocks.provinceOnError!({
        data: { validation: { provinceCode: ['Choose the province this branch operates in.'] } },
        message: 'Invalid',
      })
    );
    expect(picker).toHaveAttribute('aria-invalid', 'true');
    expect(picker).toHaveAttribute('aria-describedby', 'branch-province-error');
    expect(picker).toHaveValue('PK-KP');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose the province this branch operates in.'
    );
  });
});

const jurisdictions = [
  {
    id: 'pb',
    provinceCode: 'PK-PB',
    provinceName: 'Punjab',
    version: 1,
    effectiveFrom: new Date('2026-01-01'),
    licenceCategories: ['PHARMACY'],
    permittedSchedules: ['RX'],
    provisional: false,
  },
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
];

it('shows a warning for a branch in a provisional province and none for confirmed rules', () => {
  const { unmount } = render(
    <PharmacyRegulatoryProfileForm
      initial={{
        ...initial,
        branches: [{ ...initial.branches[0]!, provinceCode: 'PK-SD' }],
        jurisdictions,
      }}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent('Sindh rules are provisional');
  expect(screen.getByText('Pending legal review')).toHaveAttribute('data-tone', 'warning');
  unmount();
  render(
    <PharmacyRegulatoryProfileForm
      initial={{
        ...initial,
        branches: [{ ...initial.branches[0]!, provinceCode: 'PK-PB' }],
        jurisdictions,
      }}
    />
  );
  expect(screen.queryByText('Pending legal review')).not.toBeInTheDocument();
});

it('shows the pending warning for a branch stored with the bare province code', () => {
  render(
    <PharmacyRegulatoryProfileForm
      initial={{
        ...initial,
        branches: [{ ...initial.branches[0]!, provinceCode: 'SD' }],
        jurisdictions,
      }}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent('Sindh rules are provisional');
});

it('keeps the effective profile warning when newer published rules and the draft are confirmed', () => {
  const version = {
    id: 'version-1',
    branchId: 'branch-1',
    version: 1,
    provinceCode: 'PK-SD',
    provinceName: 'Sindh',
    pendingLegalReview: true,
    effective: true,
    inForce: false,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    licenceCategory: 'PHARMACY',
    licenceNumber: 'LIC-1',
    licenceValidFrom: new Date('2026-01-01'),
    licenceValidTo: new Date('2027-01-01'),
    licenceEvidenceFileRef: 'evidence',
    permittedSchedules: [],
    qualifiedPersonRegistration: 'QP-1',
    qualifiedPersonValidFrom: new Date('2026-01-01'),
    qualifiedPersonValidTo: new Date('2027-01-01'),
    qualifiedPersonCoverageRosterRef: 'roster',
    ntn: null,
    strn: null,
    fiscalStatus: 'UNREGISTERED',
    retentionPolicy: {},
    premises: {},
    createdAt: new Date('2026-01-01'),
    isPlaceholder: false,
    jurisdictionRuleSetId: 'old-sindh',
    premisesCompletionDue: false,
    licenceExpired: false,
    qualifiedPersonCoverageExpired: false,
  } satisfies Parameters<typeof PharmacyRegulatoryProfileForm>[0]['initial']['versions'][number];
  render(
    <PharmacyRegulatoryProfileForm
      initial={{
        ...initial,
        branches: [{ ...initial.branches[0]!, provinceCode: 'PK-SD' }],
        jurisdictions: jurisdictions.map((jurisdiction) => ({
          ...jurisdiction,
          provisional: false,
        })),
        versions: [version],
      }}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent('Sindh rules are provisional');
  expect(screen.getByRole('status')).toHaveTextContent(
    'Recording a profile does not approve them for production use'
  );
});

it('tells the owner to record a new profile when confirmed successor rules exist (DEV-99)', () => {
  const version = {
    id: 'test_profile',
    version: 1,
    effective: true,
    inForce: false,
    provinceCode: 'TEST_ONLY',
    provinceName: 'TEST_ONLY',
    effectiveFrom: new Date('2026-01-01'),
    pendingLegalReview: true,
    licenceValidFrom: new Date('2026-01-01'),
    licenceValidTo: new Date('2030-01-01'),
    qualifiedPersonValidFrom: new Date('2026-01-01'),
    qualifiedPersonValidTo: new Date('2030-01-01'),
    newerConfirmedRuleSet: { version: 2, effectiveFrom: new Date('2026-06-01') },
  } as VersionRow;
  render(<PharmacyRegulatoryProfileForm initial={{ ...initial, versions: [version] }} />);
  const notice = screen.getByText(/A newer confirmed rule set is available/);
  expect(notice).toHaveTextContent('TEST_ONLY, version 2');
  expect(notice).toHaveTextContent('The owner must record a new profile version');
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.getByText('Pending legal review')).toBeInTheDocument();
});
