import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { fetchRegulatory } = vi.hoisted(() => ({ fetchRegulatory: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyOnboarding: { regulatory: { fetch: fetchRegulatory } } }),
    pharmacyOnboarding: {
      saveRegulatoryProfile: {
        useMutation: () => ({ mutate: vi.fn() }),
      },
    },
  },
}));

import { PharmacyRegulatoryProfileForm } from './regulatory-profile-form';

const jurisdictions = [
  {
    id: 'pk_ajk_provisional_v1',
    provinceCode: 'PK-AJK',
    provinceName: 'Azad Jammu and Kashmir',
    version: 1,
    effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
    licenceCategories: [],
    permittedSchedules: [],
    provisional: true,
    pendingLegalReview: false,
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
];

const branches = [
  {
    id: 'branch-1',
    name: 'Clifton',
    city: 'Karachi',
    addressLine: '1 Sea View Road',
    provinceCode: 'SD',
  },
  {
    id: 'branch-2',
    name: 'Lahore',
    city: 'Lahore',
    addressLine: '2 Mall Road',
    provinceCode: 'PB',
  },
];

function regulatory(selectedBranchId: string) {
  return { branches, jurisdictions, selectedBranchId, versions: [] } as never;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('pharmacy regulatory profile form', () => {
  it('selects the branch jurisdiction in router order and updates it when branches change', async () => {
    fetchRegulatory.mockResolvedValueOnce(regulatory('branch-2'));
    render(<PharmacyRegulatoryProfileForm initial={regulatory('branch-1')} />);

    expect(screen.getByLabelText('Province')).toHaveValue('PK-SD');
    expect(
      screen.getByRole('option', { name: 'Sindh (pending legal review)' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not legally confirmed.*cannot operate.*production/i)
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Which branch is this profile for?'), {
      target: { value: 'branch-2' },
    });

    await waitFor(() => expect(screen.getByLabelText('Province')).toHaveValue('PK-PB'));
    expect(fetchRegulatory).toHaveBeenCalledWith({ branchId: 'branch-2' });
    expect(screen.getByText(/rules are still provisional/i)).toBeInTheDocument();
  });

  it('preserves a province edit made while a branch refresh is pending', async () => {
    const request = deferred<ReturnType<typeof regulatory>>();
    fetchRegulatory.mockReturnValueOnce(request.promise);
    render(<PharmacyRegulatoryProfileForm initial={regulatory('branch-1')} />);

    fireEvent.change(screen.getByLabelText('Which branch is this profile for?'), {
      target: { value: 'branch-2' },
    });
    expect(screen.getByLabelText('Province')).toHaveValue('PK-PB');
    fireEvent.change(screen.getByLabelText('Province'), { target: { value: 'PK-SD' } });

    await act(async () => request.resolve(regulatory('branch-2')));

    expect(screen.getByLabelText('Province')).toHaveValue('PK-SD');
    expect(
      screen.getByText(/not legally confirmed.*cannot operate.*production/i)
    ).toBeInTheDocument();
  });

  it('ignores an older branch response that arrives after the latest response', async () => {
    const older = deferred<ReturnType<typeof regulatory>>();
    const latest = deferred<ReturnType<typeof regulatory>>();
    fetchRegulatory.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
    render(<PharmacyRegulatoryProfileForm initial={regulatory('branch-1')} />);
    const branch = screen.getByLabelText('Which branch is this profile for?');
    fireEvent.change(branch, { target: { value: 'branch-2' } });
    fireEvent.change(branch, { target: { value: 'branch-1' } });

    await act(async () => latest.resolve(regulatory('branch-1')));
    fireEvent.change(screen.getByLabelText('Province'), { target: { value: 'PK-AJK' } });
    await act(async () =>
      older.resolve({
        ...{ branches, jurisdictions, selectedBranchId: 'branch-2', versions: [] },
        branches: branches.map((value) => ({ ...value, name: 'Stale branch name' })),
      } as never)
    );

    expect(branch).toHaveValue('branch-1');
    expect(screen.getByLabelText('Province')).toHaveValue('PK-AJK');
    expect(screen.queryByRole('option', { name: /Stale branch name/ })).not.toBeInTheDocument();
  });

  it('ignores a stale branch error while still reporting the current request error', async () => {
    const older = deferred<ReturnType<typeof regulatory>>();
    const latest = deferred<ReturnType<typeof regulatory>>();
    fetchRegulatory.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
    render(<PharmacyRegulatoryProfileForm initial={regulatory('branch-1')} />);
    const branch = screen.getByLabelText('Which branch is this profile for?');
    fireEvent.change(branch, { target: { value: 'branch-2' } });
    fireEvent.change(branch, { target: { value: 'branch-1' } });

    await act(async () => older.reject(new Error('Old request failed')));
    expect(
      screen.queryByText('That branch could not be loaded. Try again.')
    ).not.toBeInTheDocument();
    await act(async () => latest.reject(new Error('Current request failed')));
    expect(screen.getByText('That branch could not be loaded. Try again.')).toBeInTheDocument();
  });
});
