import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn(), pending: false }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyRxSoloShift: {
      setPolicy: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: mocks.pending }),
      },
    },
  },
}));

import { RX_SOLO_SHIFT_DISCLAIMER, type RxSoloShiftBranchView } from '@/lib/pharmacy/rx-solo-shift';
import { RxSoloShiftSetting } from './rx-solo-shift-setting';

const branch = (patch: Partial<RxSoloShiftBranchView> = {}): RxSoloShiftBranchView => ({
  branchId: 'branch-1',
  branchName: 'Main Road',
  branchCode: 'MAIN',
  enabled: false,
  version: 0,
  source: 'DEFAULT',
  updatedAt: null,
  updatedByName: null,
  ...patch,
});

function renderSetting(branches: RxSoloShiftBranchView[], signOffs = [] as never[]) {
  return render(
    <RxSoloShiftSetting
      branches={branches}
      disclaimerVersion={RX_SOLO_SHIFT_DISCLAIMER.version}
      signOffs={signOffs}
      history={[]}
      timeZone="UTC"
    />
  );
}

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.refresh.mockReset();
  mocks.pending = false;
});

describe('RxSoloShiftSetting (DEV-960)', () => {
  it('turns it on only with the statement ticked and the PIN, sending the statement version', () => {
    renderSetting([branch()]);
    expect(screen.getByText(RX_SOLO_SHIFT_DISCLAIMER.text)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Turn “One pharmacist per shift” on' });
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '2580' } });
    fireEvent.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Tick the statement');
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: RX_SOLO_SHIFT_DISCLAIMER.acknowledgement })
    );
    fireEvent.click(submit);
    expect(mocks.mutate).toHaveBeenCalledWith({
      branchId: 'branch-1',
      enabled: true,
      expectedVersion: 0,
      pin: '2580',
      disclaimer: { accepted: true, version: RX_SOLO_SHIFT_DISCLAIMER.version },
    });
  });

  it('asks for the PIN before anything is sent', () => {
    renderSetting([branch()]);
    fireEvent.click(screen.getByRole('button', { name: 'Turn “One pharmacist per shift” on' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your own PIN to confirm.');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('turns it off with the PIN alone', () => {
    renderSetting([branch({ enabled: true, version: 1, source: 'STORED' })]);
    expect(screen.queryByText(RX_SOLO_SHIFT_DISCLAIMER.text)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '2580' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn “One pharmacist per shift” off' }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      branchId: 'branch-1',
      enabled: false,
      expectedVersion: 1,
      pin: '2580',
    });
  });

  it('offers no switch when the stored setting cannot be read', () => {
    renderSetting([branch({ source: 'FAIL_CLOSED' })]);
    expect(screen.getByText(/could not be read, so it stays off/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('lists each declared solo sign-off with the others on the staff list', () => {
    renderSetting([branch({ enabled: true, version: 1, source: 'STORED' })], [
      {
        auditId: 'audit-1',
        signedAt: new Date('2026-11-19T09:30:00.000Z'),
        signerId: 'u-1',
        signerName: 'Synthetic Pharmacist',
        branchId: 'branch-1',
        branchName: 'Main Road',
        saleId: 'sale-0000abcd',
        receiptNumber: 42,
        saleLineId: 'line-1',
        productName: 'Synthetic capsule 500mg',
        otherSigners: [
          { id: 'u-2', name: 'Second Pharmacist' },
          { id: 'u-3', name: null },
        ],
      },
    ] as never[]);
    const table = screen.getByRole('table');
    const row = within(table).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('Synthetic Pharmacist');
    expect(row).toHaveTextContent('Receipt 42');
    expect(row).toHaveTextContent('Synthetic capsule 500mg');
    expect(row).toHaveTextContent('Second Pharmacist, Unnamed member');
  });

  it('explains an empty list and a pharmacy without branches', () => {
    renderSetting([]);
    expect(screen.getByText('No active branches')).toBeInTheDocument();
    expect(screen.getByText(/No declared solo sign-offs yet/)).toBeInTheDocument();
  });
});
