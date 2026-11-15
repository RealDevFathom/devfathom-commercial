import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isLoading: false,
  error: null as { message: string; data?: { code: string } } | null,
  refetch: vi.fn(),
  input: vi.fn(),
}));

const NOTE = 'Shift handover — 2026-11-10 (day closed)\n- Pending Rx: 2 emergency supplies';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      shiftHandoverNote: {
        useQuery: (input: unknown) => {
          mocks.input(input);
          return {
            isLoading: mocks.isLoading,
            error: mocks.error,
            refetch: mocks.refetch,
            data: mocks.error
              ? undefined
              : {
                  currency: 'PKR',
                  note: NOTE,
                  policyVersion: 'CC01-2026-11-01',
                  pendingRx: { count: 2 },
                  promised: { openOrders: 3, overdueOrders: 1, restockPromises: 4 },
                  cash: { varianceMinor: -200_000 },
                  flags: [{ kind: 'CLOSE_VARIANCE' }],
                },
          };
        },
      },
    },
  },
}));

import { ShiftHandoverPanel } from './shift-handover-panel';

afterEach(cleanup);
beforeEach(() => {
  mocks.isLoading = false;
  mocks.error = null;
  mocks.refetch.mockReset();
  mocks.input.mockReset();
});

describe('ShiftHandoverPanel', () => {
  it('shows the handover figures and an editable draft note', () => {
    render(<ShiftHandoverPanel branchId="b" date="2026-11-10" />);
    expect(mocks.input).toHaveBeenCalledWith({
      branchId: 'b',
      businessDate: new Date('2026-11-10T00:00:00.000Z'),
    });
    expect(screen.getByTestId('handover-Pending Rx')).toHaveTextContent('2');
    expect(screen.getByTestId('handover-Open customer orders')).toHaveTextContent('3 (1 overdue)');
    expect(screen.getByTestId('handover-Restock promises')).toHaveTextContent('4');
    expect(screen.getByText('Draft · 1 to review')).toBeInTheDocument();
    const draft = screen.getByLabelText('Handover note for the next shift');
    expect(draft).toHaveValue(NOTE);
    fireEvent.change(draft, { target: { value: 'Edited by owner' } });
    expect(draft).toHaveValue('Edited by owner');
    fireEvent.click(screen.getByRole('button', { name: 'Reset draft' }));
    expect(draft).toHaveValue(NOTE);
  });

  it('copies the edited draft, not the original', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ShiftHandoverPanel branchId="b" date="2026-11-10" />);
    fireEvent.change(screen.getByLabelText('Handover note for the next shift'), {
      target: { value: 'Edited note' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy note' }));
    expect(writeText).toHaveBeenCalledWith('Edited note');
    await waitFor(() => expect(screen.getByText('Handover note copied.')).toBeInTheDocument());
  });

  it('says so, without a retry, when the owner may not view it', () => {
    mocks.error = { message: 'no', data: { code: 'FORBIDDEN' } };
    render(<ShiftHandoverPanel branchId="b" date="2026-11-10" />);
    expect(screen.getByText(/permission to view the shift handover note/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry handover note' })).toBeNull();
  });

  it('offers a retry when the note fails to load', () => {
    mocks.error = { message: 'boom' };
    render(<ShiftHandoverPanel branchId="b" date="2026-11-10" />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry handover note' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('shows a loading state', () => {
    mocks.isLoading = true;
    render(<ShiftHandoverPanel branchId="b" date="2026-11-10" />);
    expect(screen.getByRole('status')).toHaveTextContent('Drawing up the handover note');
  });
});
