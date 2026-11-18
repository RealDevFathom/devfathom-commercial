import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscountMaximumPanel, percentToBps } from './discount-maximum-panel';

const mocks = vi.hoisted(() => ({
  query: {
    data: { maxDiscountBps: 1_000, canChange: true } as
      { maxDiscountBps: number; canChange: boolean } | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  save: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      discountMaximum: { useQuery: () => mocks.query },
      saveDiscountMaximum: {
        useMutation: () => ({ mutateAsync: mocks.save, isPending: false }),
      },
    },
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.data = { maxDiscountBps: 1_000, canChange: true };
  mocks.query.isLoading = false;
  mocks.query.isError = false;
  mocks.query.refetch.mockResolvedValue({ data: mocks.query.data });
  mocks.save.mockResolvedValue({ maxDiscountBps: 1_250 });
});

describe("DEV-66 owner's maximum discount", () => {
  it('converts a percentage to basis points and refuses anything outside 0-100%', () => {
    expect(percentToBps('12.5')).toBe(1_250);
    expect(percentToBps('0')).toBe(0);
    expect(percentToBps('100')).toBe(10_000);
    for (const bad of ['', '-1', '100.01', '101', '1.234', 'ten'])
      expect(percentToBps(bad)).toBeNull();
  });

  it('shows the stored maximum and lets the owner change it with their PIN', async () => {
    render(<DiscountMaximumPanel branchId="branch" />);
    expect(screen.getByLabelText('Maximum discount (%)')).toHaveValue('10');
    fireEvent.change(screen.getByLabelText('Maximum discount (%)'), { target: { value: '12.5' } });
    // No save without the owner's own PIN.
    expect(screen.getByRole('button', { name: 'Save maximum discount' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save maximum discount' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        branchId: 'branch',
        maxDiscountBps: 1_250,
        pin: '2468',
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Maximum discount saved.');
    expect(screen.getByLabelText('Your PIN')).toHaveValue('');
  });

  it('says plainly that no maximum is set yet and invites the owner to set one', () => {
    mocks.query.data = { maxDiscountBps: 10_000, canChange: true };
    render(<DiscountMaximumPanel branchId="branch" />);
    expect(screen.getByText(/No maximum discount is set yet/)).toHaveTextContent(
      'Set one below to cap every discount.'
    );
    expect(screen.getByLabelText('Maximum discount (%)')).toHaveValue('');
    expect(screen.getByLabelText('Maximum discount (%)')).toHaveAttribute('placeholder', 'Not set');
  });

  it('names the discount right by its plain label', () => {
    render(<DiscountMaximumPanel branchId="branch" />);
    expect(
      screen.getByText(/Give discounts without manager approval/, { exact: false })
    ).toBeInTheDocument();
  });

  it('shows the server refusal, such as a wrong PIN, and clears the PIN', async () => {
    mocks.save.mockRejectedValue(new Error('That PIN is not correct.'));
    render(<DiscountMaximumPanel branchId="branch" />);
    fireEvent.change(screen.getByLabelText('Maximum discount (%)'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save maximum discount' }));
    expect(await screen.findByRole('status')).toHaveTextContent('That PIN is not correct.');
    expect(screen.getByLabelText('Your PIN')).toHaveValue('');
  });

  it('keeps an invalid value for correction without saving', async () => {
    render(<DiscountMaximumPanel branchId="branch" />);
    fireEvent.change(screen.getByLabelText('Maximum discount (%)'), { target: { value: '150' } });
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save maximum discount' }));
    expect(await screen.findByRole('status')).toHaveTextContent('from 0 to 100');
    expect(screen.getByLabelText('Maximum discount (%)')).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('is read-only for everyone but the owner', () => {
    mocks.query.data = { maxDiscountBps: 1_000, canChange: false };
    render(<DiscountMaximumPanel branchId="branch" />);
    expect(screen.getByLabelText('Maximum discount (%)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save maximum discount' })).toBeNull();
    expect(screen.queryByLabelText('Your PIN')).toBeNull();
    expect(screen.getByText('Only the owner can change the maximum discount.')).toBeInTheDocument();
  });

  it('explains a failed load with a retry', () => {
    mocks.query.data = undefined;
    mocks.query.isError = true;
    render(<DiscountMaximumPanel branchId="branch" />);
    expect(screen.getByRole('alert')).toHaveTextContent('The maximum discount is unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.query.refetch).toHaveBeenCalled();
  });
});
