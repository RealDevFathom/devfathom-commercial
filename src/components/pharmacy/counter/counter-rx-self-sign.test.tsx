import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Line = {
  reviewItemId: string;
  saleLineId: string;
  productName: string;
  controlled: boolean;
  rungUpByYou: boolean;
  maySelfSign: boolean;
  askName: string | null;
};
type Pin = { state: 'SET' | 'NOT_SET' | 'RESET'; locked: boolean; lockedUntil: Date | null };

const mocks = vi.hoisted(() => ({
  data: undefined as { lines: Line[]; pin: Pin | null } | undefined,
  queryInput: vi.fn(),
  refetch: vi.fn(),
  selfSign: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyDispensing: {
      counterSignStatus: {
        useQuery: (input: unknown, options: { enabled: boolean }) => {
          mocks.queryInput(input, options);
          return {
            data: options.enabled ? mocks.data : undefined,
            refetch: mocks.refetch,
            isFetching: false,
          };
        },
      },
      selfSignReview: {
        useMutation: () => ({ mutateAsync: mocks.selfSign, isPending: false }),
      },
    },
  },
}));

import { CounterRxSelfSign } from './counter-rx-self-sign';

const line = (patch: Partial<Line> = {}): Line => ({
  reviewItemId: 'review-1',
  saleLineId: 'line-1',
  productName: 'Synthetic capsule 500mg',
  controlled: false,
  rungUpByYou: true,
  maySelfSign: true,
  askName: null,
  ...patch,
});
const pinSet: Pin = { state: 'SET', locked: false, lockedUntil: null };

beforeEach(() => {
  mocks.data = undefined;
  mocks.queryInput.mockReset();
  mocks.refetch.mockReset().mockResolvedValue({});
  mocks.selfSign.mockReset();
});

describe('CounterRxSelfSign (DEV-950)', () => {
  it('shows nothing when no prescription line waits for a signature', () => {
    mocks.data = { lines: [], pin: null };
    const { container } = render(<CounterRxSelfSign branchId="b" saleId="s" enabled />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not ask the server when it is not enabled', () => {
    mocks.data = { lines: [line()], pin: pinSet };
    const { container } = render(<CounterRxSelfSign branchId="b" saleId="s" enabled={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.queryInput).toHaveBeenCalledWith(
      { branchId: 'b', saleId: 's' },
      expect.objectContaining({ enabled: false })
    );
  });

  it('lets a lone pharmacist sign their own line with their PIN, then refreshes', async () => {
    mocks.data = { lines: [line()], pin: pinSet };
    mocks.selfSign.mockResolvedValue({ decisionId: 'd-1' });
    const onSigned = vi.fn();
    render(<CounterRxSelfSign branchId="b" saleId="s" enabled onSigned={onSigned} />);
    expect(screen.getByText(/nobody else at this branch can sign it/)).toBeInTheDocument();
    expect(screen.getByText(/recorded as self-approved/)).toBeInTheDocument();
    const sign = screen.getByRole('button', { name: 'Sign with my PIN' });
    expect(sign).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '48a26' } });
    expect(screen.getByLabelText('Your PIN')).toHaveValue('4826');
    fireEvent.click(sign);
    await waitFor(() =>
      expect(mocks.selfSign).toHaveBeenCalledWith({ reviewItemId: 'review-1', pin: '4826' })
    );
    await waitFor(() => expect(onSigned).toHaveBeenCalled());
    expect(mocks.refetch).toHaveBeenCalled();
    expect(screen.getByLabelText('Your PIN')).toHaveValue('');
  });

  it('shows the server refusal of a wrong PIN and clears the PIN', async () => {
    mocks.data = { lines: [line()], pin: pinSet };
    mocks.selfSign.mockRejectedValue(
      Object.assign(new Error('That PIN was not accepted. Enter your own PIN to sign.'), {
        data: { code: 'FORBIDDEN' },
      })
    );
    render(<CounterRxSelfSign branchId="b" saleId="s" enabled />);
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '4826' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign with my PIN' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That PIN was not accepted.');
    expect(screen.getByLabelText('Your PIN')).toHaveValue('');
    // A refused PIN may have just locked it, so the line and PIN state are read again.
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
  });

  it('sends a pharmacist without a PIN to set one up', () => {
    mocks.data = { lines: [line()], pin: { state: 'NOT_SET', locked: false, lockedUntil: null } };
    render(<CounterRxSelfSign branchId="b" saleId="s" enabled />);
    expect(screen.queryByLabelText('Your PIN')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up your PIN' })).toHaveAttribute(
      'href',
      '/pharmacy/settings/pin'
    );
  });

  it('takes no PIN while it is locked, and checks again on request', async () => {
    mocks.data = { lines: [line()], pin: { state: 'SET', locked: true, lockedUntil: new Date() } };
    render(<CounterRxSelfSign branchId="b" saleId="s" enabled />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your PIN is locked after too many wrong tries. Wait until the lock ends, then try again.'
    );
    const field = screen.getByLabelText('Your PIN');
    expect(field).toBeDisabled();
    fireEvent.change(field, { target: { value: '4826' } });
    expect(screen.getByRole('button', { name: 'Sign with my PIN' })).toBeDisabled();
    expect(mocks.selfSign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
  });

  it('names the other pharmacist who signs when the solo rule does not apply', () => {
    mocks.data = {
      lines: [line({ maySelfSign: false, askName: 'Synthetic Pharmacist' })],
      pin: null,
    };
    render(<CounterRxSelfSign branchId="b" saleId="s" enabled />);
    expect(screen.queryByLabelText('Your PIN')).not.toBeInTheDocument();
    expect(screen.getByText(/Ask Synthetic Pharmacist to sign it/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'pharmacist queue' })).toHaveAttribute(
      'href',
      '/pharmacy/pharmacist-queue'
    );
  });

  it('never offers a controlled line for self-signature', () => {
    mocks.data = { lines: [line({ maySelfSign: false, controlled: true })], pin: null };
    render(<CounterRxSelfSign branchId="b" saleId="s" enabled />);
    expect(screen.queryByLabelText('Your PIN')).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be self-signed/)).toBeInTheDocument();
  });

  it('points someone else’s line to the pharmacist queue', () => {
    mocks.data = { lines: [line({ rungUpByYou: false, maySelfSign: false })], pin: null };
    render(<CounterRxSelfSign branchId="b" saleId="s" enabled />);
    expect(screen.queryByLabelText('Your PIN')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'pharmacist queue' })).toBeInTheDocument();
  });
});
