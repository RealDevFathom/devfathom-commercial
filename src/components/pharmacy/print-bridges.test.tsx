import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: undefined as unknown,
  enroll: vi.fn(),
  enrollReset: vi.fn(),
  enrollOptions: undefined as unknown,
  revoke: vi.fn(),
  invalidateBridges: vi.fn(),
  invalidateStatus: vi.fn(),
  bridgesInput: undefined as unknown,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyPrinting: {
        bridges: { invalidate: mocks.invalidateBridges },
        printerStatus: { invalidate: mocks.invalidateStatus },
      },
    }),
    pharmacyPrinting: {
      bridges: {
        useQuery: (input: unknown) => {
          mocks.bridgesInput = input;
          return mocks.list;
        },
      },
      enrollBridge: {
        useMutation: (options: unknown) => {
          mocks.enrollOptions = options;
          return { mutateAsync: mocks.enroll, reset: mocks.enrollReset, isPending: false };
        },
      },
      revokeBridge: {
        useMutation: () => ({ mutateAsync: mocks.revoke, isPending: false }),
      },
    },
  },
}));

import { PharmacyPrintBridges } from './print-bridges';

const ok = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
const active = {
  id: 'bridge-1',
  name: 'Front counter PC',
  status: 'ACTIVE',
  online: true,
  lastSeenAt: '2026-11-18T10:00:00.000Z',
  printerId: 'queue:///Receipt_Printer',
  createdAt: '2026-11-01T10:00:00.000Z',
};
const revoked = {
  ...active,
  id: 'bridge-0',
  name: 'Old laptop',
  status: 'REVOKED',
  online: false,
  lastSeenAt: null,
};
const CREDENTIAL = 'ppb_test-placeholder-not-a-real-credential-0000.b3JnLWE';

beforeEach(() => {
  mocks.list = ok([active, revoked]);
  mocks.enroll.mockReset();
  mocks.enrollReset.mockReset();
  mocks.revoke.mockReset();
  mocks.invalidateBridges.mockReset();
  mocks.invalidateStatus.mockReset();
});
afterEach(cleanup);

function renderPanel() {
  return render(<PharmacyPrintBridges branchId="b1" branchName="Main" />);
}

describe('PharmacyPrintBridges', () => {
  it('lists the branch bridges with their connection state and printer address', () => {
    renderPanel();
    expect(mocks.bridgesInput).toEqual({ branchId: 'b1' });
    const list = screen.getByRole('list', { name: 'Print bridges for Main' });
    expect(list).toHaveTextContent('Front counter PC');
    expect(list).toHaveTextContent('queue:///Receipt_Printer');
    expect(list).toHaveTextContent('Online');
    expect(list).toHaveTextContent('Revoked');
    expect(list).toHaveTextContent('Never connected');
    // A revoked bridge cannot be revoked again.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });

  it('enrols a bridge for the branch and shows its credential once', async () => {
    mocks.enroll.mockResolvedValue({
      bridge: { ...active, id: 'bridge-2', name: 'Back office' },
      credential: CREDENTIAL,
      notice: 'Store this credential now.',
    });
    renderPanel();
    expect(mocks.enrollOptions).toMatchObject({ gcTime: 0, retry: false });
    const submit = screen.getByRole('button', { name: 'Enrol print bridge' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Bridge name'), { target: { value: ' Back office ' } });
    fireEvent.change(screen.getByLabelText('Printer address on the bridge computer'), {
      target: { value: 'queue:///Receipt_Printer' },
    });
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(mocks.enroll).toHaveBeenCalledWith({
      branchId: 'b1',
      name: 'Back office',
      printerId: 'queue:///Receipt_Printer',
    });
    expect(mocks.enrollReset).toHaveBeenCalled();
    expect(mocks.invalidateBridges).toHaveBeenCalledWith({ branchId: 'b1' });
    expect(mocks.invalidateStatus).toHaveBeenCalledWith({ branchId: 'b1' });
    expect(screen.getByLabelText('Credential for Back office')).toHaveValue(CREDENTIAL);
    expect(screen.getByText(/Shown once/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Done, I have copied it' }));
    expect(screen.queryByDisplayValue(CREDENTIAL)).toBeNull();
    expect(screen.getByRole('button', { name: 'Enrol print bridge' })).toBeTruthy();
  });

  it('shows the server refusal when enrolment fails and keeps what was typed', async () => {
    mocks.enroll.mockRejectedValue(
      new Error('Use tcp://host:9100, queue:///encoded-name, or a /dev/ path.')
    );
    renderPanel();
    fireEvent.change(screen.getByLabelText('Bridge name'), { target: { value: 'Front' } });
    fireEvent.change(screen.getByLabelText('Printer address on the bridge computer'), {
      target: { value: 'lp0' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enrol print bridge' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('queue:///encoded-name');
    expect(screen.getByLabelText('Bridge name')).toHaveValue('Front');
    expect(screen.queryByLabelText(/Credential for/)).toBeNull();
  });

  it('revokes only after a confirmation', async () => {
    mocks.revoke.mockResolvedValue({ bridgeId: 'bridge-1', status: 'REVOKED' });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(mocks.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Confirm revoke' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    });
    expect(mocks.revoke).toHaveBeenCalledWith({ branchId: 'b1', bridgeId: 'bridge-1' });
    expect(screen.getByRole('status')).toHaveTextContent('Front counter PC is revoked');
    expect(mocks.invalidateBridges).toHaveBeenCalledWith({ branchId: 'b1' });
  });

  it('explains an empty branch, a load failure and a forbidden read', () => {
    mocks.list = ok([]);
    const { unmount } = renderPanel();
    expect(screen.getByText(/No print bridge is enrolled for Main/)).toBeTruthy();
    unmount();

    const refetch = vi.fn();
    mocks.list = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Branch is outside your scope.'),
      refetch,
    };
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Branch is outside your scope.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });
});
