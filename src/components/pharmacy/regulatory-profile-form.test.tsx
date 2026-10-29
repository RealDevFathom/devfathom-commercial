import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), mutate: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyOnboarding: { regulatory: { fetch: mocks.fetch } } }),
    pharmacyOnboarding: {
      saveRegulatoryProfile: {
        useMutation: () => ({ isPending: false, mutate: mocks.mutate }),
      },
    },
  },
}));

import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

type Regulatory = ComponentProps<typeof PharmacyRegulatoryProfileForm>['initial'];

const branches = [
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
    provinceCode: 'PK-SD',
  },
];
const jurisdictions = [
  {
    id: 'rules-punjab',
    provinceCode: 'PK-PB',
    provinceName: 'Punjab',
    version: 1,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    licenceCategories: ['Retail A'],
    permittedSchedules: ['A1'],
    provisional: false,
  },
  {
    id: 'rules-sindh',
    provinceCode: 'PK-SD',
    provinceName: 'Sindh',
    version: 1,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    licenceCategories: ['Retail B'],
    permittedSchedules: ['B1'],
    provisional: false,
  },
] satisfies Regulatory['jurisdictions'];

function profile(branch: 'a' | 'b'): Regulatory['versions'][number] {
  const b = branch.toUpperCase();
  return {
    id: `profile-${branch}`,
    branchId: `branch-${branch}`,
    version: 1,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    provinceCode: branch === 'a' ? 'PK-PB' : 'PK-SD',
    licenceCategory: `Retail ${b}`,
    licenceNumber: `LIC-${b}`,
    licenceValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    licenceValidTo: new Date('2027-12-31T00:00:00.000Z'),
    licenceEvidenceFileRef: `/evidence-${branch}.pdf`,
    permittedSchedules: [`${b}1`],
    qualifiedPersonRegistration: `QP-${b}`,
    qualifiedPersonValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    qualifiedPersonValidTo: new Date('2027-12-31T00:00:00.000Z'),
    qualifiedPersonCoverageRosterRef: `/roster-${branch}.pdf`,
    ntn: `NTN-${b}`,
    strn: `STRN-${b}`,
    fiscalStatus: branch === 'a' ? 'REGISTERED' : 'EXEMPT',
    retentionPolicy: {
      prescriptionsYears: branch === 'a' ? 5 : 7,
      invoicesYears: branch === 'a' ? 6 : 8,
      controlledRegisterYears: branch === 'a' ? 10 : 12,
    },
    premises: { storageDescription: `Storage ${b}` },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    isPlaceholder: false,
    provinceName: branch === 'a' ? 'Punjab' : 'Sindh',
    effective: true,
    inForce: true,
    licenceExpired: false,
    qualifiedPersonCoverageExpired: false,
  };
}

function regulatory(branch: 'a' | 'b'): Regulatory {
  return {
    branches,
    jurisdictions,
    selectedBranchId: `branch-${branch}`,
    versions: [profile(branch)],
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('PharmacyRegulatoryProfileForm', () => {
  it("waits for the selected branch's complete profile before it can be saved", async () => {
    mocks.fetch.mockResolvedValueOnce(regulatory('b'));
    render(<PharmacyRegulatoryProfileForm initial={regulatory('a')} />);

    fireEvent.change(screen.getByLabelText('Which branch is this profile for?'), {
      target: { value: 'branch-b' },
    });
    expect(screen.getByRole('button', { name: 'Save this version' })).toBeDisabled();

    await waitFor(() => expect(screen.getByLabelText('Licence number')).toHaveValue('LIC-B'));
    expect(screen.getByLabelText('Premises address')).toHaveValue('45 Murree Road');
    expect(screen.getByLabelText('Premises city')).toHaveValue('Rawalpindi');
    expect(screen.getByLabelText('Medicine storage at these premises')).toHaveValue('Storage B');
    expect(screen.getByLabelText('Province')).toHaveValue('PK-SD');
    expect(screen.getByLabelText('Licence category')).toHaveValue('Retail B');
    expect(screen.getByLabelText('B1')).toBeChecked();
    expect(screen.getByLabelText('Registration number')).toHaveValue('QP-B');
    expect(screen.getByLabelText('Coverage roster')).toHaveValue('/roster-b.pdf');
    expect(screen.getByLabelText('NTN')).toHaveValue('NTN-B');
    expect(screen.getByLabelText('STRN')).toHaveValue('STRN-B');
    expect(screen.getByLabelText('Fiscal status')).toHaveValue('EXEMPT');
    expect(screen.getByLabelText('Keep prescriptions (years)')).toHaveValue(7);
    expect(screen.getByText('Licence evidence attached.')).toBeInTheDocument();

    fireEvent.submit(screen.getByRole('button', { name: 'Save this version' }).closest('form')!);
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch-b',
        provinceCode: 'PK-SD',
        premisesAddressLine: '45 Murree Road',
        premisesCity: 'Rawalpindi',
        premisesStorageDescription: 'Storage B',
        licenceCategory: 'Retail B',
        licenceNumber: 'LIC-B',
        licenceEvidenceFileRef: '/evidence-b.pdf',
        permittedSchedules: ['B1'],
        qualifiedPersonRegistration: 'QP-B',
        qualifiedPersonCoverageRosterRef: '/roster-b.pdf',
        ntn: 'NTN-B',
        strn: 'STRN-B',
        fiscalStatus: 'EXEMPT',
        retentionPrescriptionYears: 7,
        retentionInvoiceYears: 8,
        retentionControlledRegisterYears: 12,
      })
    );
  });

  it('ignores an out-of-order response during rapid A to B to A selection', async () => {
    let resolveB!: (value: Regulatory) => void;
    const delayedB = new Promise<Regulatory>((resolve) => {
      resolveB = resolve;
    });
    mocks.fetch.mockReturnValueOnce(delayedB).mockResolvedValueOnce(regulatory('a'));
    render(<PharmacyRegulatoryProfileForm initial={regulatory('a')} />);

    const selector = screen.getByLabelText('Which branch is this profile for?');
    fireEvent.change(selector, { target: { value: 'branch-b' } });
    fireEvent.change(selector, { target: { value: 'branch-a' } });
    await waitFor(() => expect(screen.getByLabelText('Licence number')).toHaveValue('LIC-A'));
    resolveB(regulatory('b'));
    await Promise.resolve();

    expect(screen.getByLabelText('Which branch is this profile for?')).toHaveValue('branch-a');
    expect(screen.getByLabelText('Licence number')).toHaveValue('LIC-A');
    expect(screen.getByLabelText('Premises address')).toHaveValue('12 Mall Road');
  });
});
