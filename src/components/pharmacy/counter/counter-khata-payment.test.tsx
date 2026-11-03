import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ repay: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      khataRepaymentAccounts: {
        useQuery: () => ({
          data: [{ id: 'family-a', displayName: 'Test family', balanceMinor: 10000 }],
          isLoading: false,
          isError: false,
        }),
      },
      recordKhataRepayment: { useMutation: () => ({ mutateAsync: mocks.repay, isPending: false }) },
    },
  },
}));
import { buildKhataPaymentSlip, CounterKhataPayment } from './counter-khata-payment';

const props = {
  branchId: 'branch-a',
  branchName: 'Test branch',
  storageScope: 'org-a:actor-a:branch-a',
  drawerSessionId: 'drawer-a',
  onRecorded: vi.fn(),
};
beforeEach(() => {
  localStorage.clear();
  mocks.repay.mockReset();
  vi.spyOn(window, 'open').mockReturnValue(null);
});

describe('khata payment slip', () => {
  it('prints repayment evidence, PKT time and escapes account/branch content', () => {
    const html = buildKhataPaymentSlip(
      {
        receiptId: 'payment-a',
        accountName: '<Family & Co>',
        amountMinor: 2500,
        remainingBalanceMinor: 7500,
        tender: 'CASH',
        occurredAt: new Date('2026-11-03T10:00:00Z'),
      },
      '<Main branch>'
    );
    expect(html).toContain('KHATA PAYMENT RECEIPT');
    expect(html).toContain('Receipt: payment-a');
    expect(html).toContain('Amount received: 25.00');
    expect(html).toContain('&lt;Family &amp; Co&gt;');
    expect(html).not.toContain('<Family & Co>');
    expect(html).toContain('PKT');
  });
  it('persists before dispatch, suppresses double clicks, and retries the same request after remount', async () => {
    let reject!: (reason: Error) => void;
    mocks.repay.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const view = render(<CounterKhataPayment {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Khata payment' }));
    fireEvent.change(screen.getByLabelText('Khata account'), { target: { value: 'family-a' } });
    fireEvent.change(screen.getByLabelText('Amount received'), { target: { value: '25.00' } });
    const pay = screen.getByRole('button', { name: 'Record payment & print slip' });
    fireEvent.click(pay);
    await waitFor(() => expect(mocks.repay).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('devfathom.khata-payment:org-a:actor-a:branch-a')).toContain(
      '2500'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check saved payment' }));
    expect(mocks.repay).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('Network lost')));
    const original = mocks.repay.mock.calls[0]![0];
    view.unmount();
    mocks.repay.mockResolvedValueOnce({
      receiptId: 'payment-a',
      paidMinor: 2500,
      remainingBalanceMinor: 7500,
      tender: 'CASH',
      occurredAt: '2026-11-03T10:00:00Z',
    });
    render(<CounterKhataPayment {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Khata payment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check saved payment' }));
    await screen.findByText('Payment recorded.');
    expect(mocks.repay.mock.calls[1]![0]).toEqual(original);
    expect(localStorage.getItem('devfathom.khata-payment:org-a:actor-a:branch-a')).toBeNull();
    expect(screen.getByRole('button', { name: 'Print slip' })).toBeEnabled();
  });
  it('does not dispatch when persistence is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage blocked');
    });
    render(<CounterKhataPayment {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Khata payment' }));
    fireEvent.change(screen.getByLabelText('Khata account'), { target: { value: 'family-a' } });
    fireEvent.change(screen.getByLabelText('Amount received'), { target: { value: '25.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment & print slip' }));
    await screen.findByText(/Storage blocked/);
    expect(mocks.repay).not.toHaveBeenCalled();
  });
});
