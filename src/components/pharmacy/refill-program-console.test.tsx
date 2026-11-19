import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RefillProgramConsole } from './refill-program-console';

type Query = { data?: unknown; isLoading?: boolean; isSuccess?: boolean; error?: unknown };

const mocks = vi.hoisted(() => ({
  program: {} as Query,
  prescriptions: {} as Query,
  approvers: {} as Query,
  catalog: {} as Query,
  setStatus: vi.fn(),
  openCycle: vi.fn(),
  openDue: vi.fn(),
  release: vi.fn(),
  checkout: vi.fn(),
  approve: vi.fn(),
  create: vi.fn(),
  invalidate: vi.fn(),
  mutation: (fn: (input: unknown) => Promise<unknown>) => ({
    useMutation: () => ({ mutateAsync: fn, isPending: false, data: undefined }),
  }),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyOrdering: {
      branches: {
        useQuery: () => ({
          data: { branches: [{ id: 'branch-a', name: 'Main' }], currency: 'PKR' },
          isSuccess: true,
        }),
      },
      customers: {
        useQuery: () => ({ data: [{ id: 'cust-1', displayName: 'Ayesha', phoneLast4: '4567' }] }),
      },
      refillProgram: { useQuery: () => mocks.program },
      subscriptionCatalog: { useQuery: () => mocks.catalog },
      subscriptionCyclePrescriptions: { useQuery: () => mocks.prescriptions },
      subscriptionCycleApprovers: { useQuery: () => mocks.approvers },
      setSubscriptionStatus: mocks.mutation(mocks.setStatus),
      openSubscriptionCycle: mocks.mutation(mocks.openCycle),
      openDueSubscriptionCycles: mocks.mutation(mocks.openDue),
      releaseSubscriptionCycle: mocks.mutation(mocks.release),
      startSubscriptionCycleCheckout: mocks.mutation(mocks.checkout),
      approveSubscriptionCycle: mocks.mutation(mocks.approve),
      createSubscription: mocks.mutation(mocks.create),
    },
    useUtils: () => ({ pharmacyOrdering: { refillProgram: { invalidate: mocks.invalidate } } }),
  },
}));

const DUE = new Date('2026-12-01T00:00:00.000Z');

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    status: 'ACTIVE',
    packsPerCycle: 3,
    cycleDays: 30,
    paymentMode: 'PREPAY',
    nextDueAt: new Date('2026-12-31T00:00:00.000Z'),
    customer: { id: 'cust-1', displayName: 'Ayesha', phoneLast4: '4567' },
    item: { productName: 'Metformin 500', presentation: 'Tablet', prescriptionOnly: true },
    cycles: [
      {
        id: 'cycle-1',
        status: 'AWAITING_PHARMACIST',
        dueAt: DUE,
        approvedAt: null,
        selfApproved: false,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.program = { data: [subscription()], isLoading: false };
  mocks.catalog = {
    data: [
      {
        medicineId: 'med-1',
        productName: 'Metformin 500',
        prescriptionOnly: true,
        presentationId: 'pres-1',
        presentation: 'Tablet',
        packLevelId: 'pack-1',
        packLabel: 'STRIP',
      },
    ],
    isLoading: false,
  };
  mocks.prescriptions = {
    data: [
      {
        id: 'rx-line-1',
        prescriberName: 'Dr Khan',
        validFrom: new Date('2026-11-01T00:00:00.000Z'),
        validUntil: new Date('2027-04-30T00:00:00.000Z'),
        remainingUnits: 180,
        repeatsLeft: 5,
      },
    ],
    isLoading: false,
  };
  mocks.approvers = {
    data: [{ id: 'staff-1', name: 'Owner', self: true }],
    isLoading: false,
    isSuccess: true,
  };
  for (const fn of [mocks.setStatus, mocks.openCycle, mocks.release, mocks.checkout])
    fn.mockResolvedValue({});
  mocks.approve.mockResolvedValue({ id: 'cycle-1' });
  mocks.create.mockResolvedValue({ id: 'sub-2' });
  mocks.openDue.mockResolvedValue({ opened: [], skipped: [] });
});

describe('DEV-73 refill program screen', () => {
  it('lists each subscription with its item, status and held cycle', () => {
    render(<RefillProgramConsole />);
    const table = screen.getByRole('region', { name: 'Refill subscriptions' });
    expect(within(table).getByText('Ayesha')).toBeInTheDocument();
    expect(within(table).getByText('Metformin 500')).toBeInTheDocument();
    expect(within(table).getByText('Held for pharmacist')).toBeInTheDocument();
    expect(within(table).getByText('Active')).toBeInTheDocument();
  });

  it('offers a prescription cycle only to the pharmacist, never straight to the counter', () => {
    render(<RefillProgramConsole />);
    expect(screen.getByRole('button', { name: 'Pharmacist sign-off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to counter' })).not.toBeInTheDocument();
  });

  it('signs a cycle only with a covering prescription, a pharmacist and their PIN', async () => {
    render(<RefillProgramConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Pharmacist sign-off' }));
    const sign = screen.getByRole('button', { name: 'Sign and release cycle' });
    expect(screen.getByText(/no\s+emergency exception/i)).toBeInTheDocument();
    expect(sign).toBeDisabled();

    fireEvent.click(screen.getByRole('radio'));
    fireEvent.change(screen.getByLabelText('Signing pharmacist'), {
      target: { value: 'staff-1' },
    });
    expect(sign).toBeDisabled();
    const pin = screen.getByLabelText('Pharmacist PIN');
    expect(pin).toHaveAttribute('type', 'password');
    fireEvent.change(pin, { target: { value: '7391' } });
    expect(sign).toBeEnabled();
    fireEvent.click(sign);

    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith({
        branchId: 'branch-a',
        cycleId: 'cycle-1',
        prescriptionLineId: 'rx-line-1',
        pharmacistPin: { staffProfileId: 'staff-1', pin: '7391' },
      })
    );
  });

  it('tells a non-pharmacist they cannot read or sign the prescription', () => {
    mocks.prescriptions = { error: { data: { code: 'FORBIDDEN' } }, isLoading: false };
    render(<RefillProgramConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Pharmacist sign-off' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/only a pharmacist/i);
    expect(screen.getByRole('button', { name: 'Sign and release cycle' })).toBeDisabled();
  });

  it('keeps a held cycle held when no prescription covers it', () => {
    mocks.prescriptions = { data: [], isLoading: false };
    render(<RefillProgramConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Pharmacist sign-off' }));
    expect(screen.getByText(/No prescription on this customer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign and release cycle' })).toBeDisabled();
  });

  it('sends a ready cycle to the counter', async () => {
    mocks.program = {
      data: [
        subscription({
          item: { productName: 'Cetirizine', presentation: 'Tablet', prescriptionOnly: false },
          cycles: [
            {
              id: 'cycle-2',
              status: 'RESERVED',
              dueAt: DUE,
              approvedAt: null,
              selfApproved: false,
            },
          ],
        }),
      ],
    };
    render(<RefillProgramConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Send to counter' }));
    await waitFor(() =>
      expect(mocks.checkout).toHaveBeenCalledWith({ branchId: 'branch-a', cycleId: 'cycle-2' })
    );
    expect(await screen.findByRole('link', { name: 'Go to the counter' })).toHaveAttribute(
      'href',
      '/pharmacy/counter'
    );
  });

  it('lets a pharmacist sign an approved prescription cycle again before it reaches the counter', async () => {
    mocks.program = {
      data: [
        subscription({
          cycles: [
            {
              id: 'cycle-3',
              status: 'RESERVED',
              requiresPharmacist: true,
              dueAt: DUE,
              approvedAt: new Date('2026-11-28T09:00:00.000Z'),
              selfApproved: false,
            },
          ],
        }),
      ],
    };
    render(<RefillProgramConsole />);
    expect(screen.getByRole('button', { name: 'Send to counter' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign again' }));
    expect(screen.getByRole('button', { name: 'Sign and release cycle' })).toBeDisabled();
  });

  it('offers no new sign-off on a cycle without a prescription', () => {
    mocks.program = {
      data: [
        subscription({
          item: { productName: 'Cetirizine', presentation: 'Tablet', prescriptionOnly: false },
          cycles: [
            {
              id: 'cycle-4',
              status: 'RESERVED',
              requiresPharmacist: false,
              dueAt: DUE,
              approvedAt: null,
              selfApproved: false,
            },
          ],
        }),
      ],
    };
    render(<RefillProgramConsole />);
    expect(screen.queryByRole('button', { name: 'Sign again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pharmacist sign-off' })).not.toBeInTheDocument();
  });

  it('pauses a subscription and cancels one only after confirmation', async () => {
    render(<RefillProgramConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenCalledWith({
        branchId: 'branch-a',
        subscriptionId: 'sub-1',
        action: 'pause',
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.setStatus).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenLastCalledWith({
        branchId: 'branch-a',
        subscriptionId: 'sub-1',
        action: 'cancel',
      })
    );
  });

  it('shows a server refusal in plain words', async () => {
    mocks.release.mockRejectedValue(new Error('INVALID_STATE'));
    render(<RefillProgramConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip cycle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already moved on/);
  });

  it('creates a subscription for a customer and item', async () => {
    render(<RefillProgramConsole />);
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'cust-1' } });
    fireEvent.change(screen.getByLabelText('Item and pack'), {
      target: { value: 'med-1:pres-1:pack-1' },
    });
    fireEvent.change(screen.getByLabelText('Packs per cycle'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('First due date'), {
      target: { value: '2026-12-10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: 'branch-a',
          customerId: 'cust-1',
          medicineId: 'med-1',
          presentationId: 'pres-1',
          packLevelId: 'pack-1',
          packsPerCycle: 2,
          cycleDays: 30,
          reminderLeadDays: 3,
          paymentMode: 'PREPAY',
          // Midday UTC: the reminder's UTC date is the date that was picked.
          firstDueAt: new Date('2026-12-10T12:00:00.000Z'),
        })
      )
    );
  });

  it('explains the empty list and a refused role', () => {
    mocks.program = { data: [], isLoading: false };
    const { unmount } = render(<RefillProgramConsole />);
    expect(screen.getByText(/No refill subscriptions at this branch yet/)).toBeInTheDocument();
    unmount();

    mocks.program = { error: { data: { code: 'FORBIDDEN' } }, isLoading: false };
    render(<RefillProgramConsole />);
    expect(screen.getByRole('status')).toHaveTextContent(/cannot manage refill subscriptions/);
    expect(screen.queryByRole('button', { name: 'Create subscription' })).not.toBeInTheDocument();
  });
});
