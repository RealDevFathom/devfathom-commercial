import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CardTerminalCounterView } from '@/lib/pharmacy/card-terminal/counter-view';

const mocks = vi.hoisted(() => ({
  available: true,
  latest: null as CardTerminalCounterView | null,
  availabilityInput: vi.fn(),
  charge: vi.fn(),
  checkStatus: vi.fn(),
  chargePending: false,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyCardTerminal: {
      availability: {
        useQuery: (input: unknown, options: { enabled: boolean }) => {
          mocks.availabilityInput(input, options);
          return {
            data: options.enabled ? { available: mocks.available, currency: 'PKR' } : undefined,
          };
        },
      },
      attempt: {
        useQuery: () => ({
          data: mocks.latest,
          refetch: async () => ({ data: mocks.latest }),
        }),
      },
      charge: {
        useMutation: () => ({ mutateAsync: mocks.charge, isPending: mocks.chargePending }),
      },
      checkStatus: { useMutation: () => ({ mutateAsync: mocks.checkStatus, isPending: false }) },
    },
  },
}));

import { CounterCardTerminalPanel } from './counter-card-terminal-panel';

const view = (patch: Partial<CardTerminalCounterView>): CardTerminalCounterView => ({
  attemptKey: 'card-terminal:key-1',
  phase: 'PAID',
  amountMinor: 150_000,
  currency: 'PKR',
  open: false,
  canCheckStatus: false,
  statusChecks: 0,
  cardBrand: null,
  cardLast4: null,
  declineCode: null,
  reviewReason: null,
  ...patch,
});

function renderPanel(props: Partial<Parameters<typeof CounterCardTerminalPanel>[0]> = {}) {
  const onSettled = vi.fn();
  const result = render(
    <CounterCardTerminalPanel
      branchId="branch-1"
      saleId="sale-1"
      deviceId="counter-device-1"
      balanceMinor={150_000}
      businessDate={() => new Date('2026-11-18T00:00:00.000Z')}
      onSettled={onSettled}
      {...props}
    />
  );
  return { ...result, onSettled };
}

beforeEach(() => {
  mocks.available = true;
  mocks.latest = null;
  mocks.chargePending = false;
  mocks.charge.mockReset();
  mocks.checkStatus.mockReset();
  mocks.availabilityInput.mockReset();
});

describe('DEV-743 counter card-terminal panel', () => {
  it('renders nothing where no admitted terminal serves the counter', () => {
    mocks.available = false;
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
    expect(mocks.availabilityInput).toHaveBeenCalledWith(
      { branchId: 'branch-1', deviceId: 'counter-device-1' },
      expect.objectContaining({ enabled: true })
    );
  });

  it('does not ask before the counter knows its device', () => {
    const { container } = renderPanel({ deviceId: null });
    expect(container).toBeEmptyDOMElement();
    expect(mocks.availabilityInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false })
    );
  });

  it('charges the balance due once, then shows it paid and re-reads the bill', async () => {
    mocks.charge.mockImplementation(async () => {
      mocks.latest = view({ cardBrand: 'VISA', cardLast4: '4242' });
      return mocks.latest;
    });
    const { onSettled } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Charge Rs 1500.00 on terminal' }));
    await screen.findByText('Card payment recorded on this bill.');
    expect(screen.getByText(/VISA •••• 4242/)).toBeInTheDocument();
    expect(mocks.charge).toHaveBeenCalledTimes(1);
    expect(mocks.charge.mock.calls[0][0]).toEqual({
      branchId: 'branch-1',
      saleId: 'sale-1',
      deviceId: 'counter-device-1',
      businessDate: new Date('2026-11-18T00:00:00.000Z'),
      amountMinor: 150_000,
      attemptKey: expect.stringMatching(/^card-terminal:[A-Za-z0-9-]{36}$/),
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('shows a waiting state while the charge is out, with no second charge control', () => {
    mocks.chargePending = true;
    renderPanel();
    expect(screen.getByText(/Waiting for the customer at the card terminal/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('holds an unknown outcome and resolves it only by a status check', async () => {
    mocks.latest = view({ phase: 'UNKNOWN', open: true, canCheckStatus: true });
    mocks.checkStatus.mockImplementation(async () => {
      mocks.latest = view({ phase: 'PAID' });
      return mocks.latest;
    });
    const { onSettled } = renderPanel();
    expect(screen.getByText(/the customer may have been charged/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Charge/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await screen.findByText('Card payment recorded on this bill.');
    expect(mocks.checkStatus).toHaveBeenCalledWith({
      branchId: 'branch-1',
      attemptKey: 'card-terminal:key-1',
    });
    expect(mocks.charge).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('leaves manual review to a manager or owner, with no action at the counter', () => {
    mocks.latest = view({
      phase: 'MANUAL_REVIEW',
      open: true,
      reviewReason: 'Terminal approved a different amount',
    });
    renderPanel();
    expect(
      screen.getByText(/A manager or owner must review this card payment/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers a new charge after a decline', async () => {
    mocks.latest = view({ phase: 'DECLINED', declineCode: '05' });
    renderPanel();
    expect(screen.getByText(/Nothing was charged/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge Rs 1500.00 on terminal' })).toBeEnabled();
  });

  it('says a lost answer may have charged when the server holds the attempt open', async () => {
    mocks.charge.mockImplementation(async () => {
      mocks.latest = view({ phase: 'UNKNOWN', open: true, canCheckStatus: true });
      throw new Error('Failed to fetch');
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Charge Rs 1500.00 on terminal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The counter lost contact while charging.'
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check status' })).toBeEnabled());
  });

  it('says nothing was sent when the server refused before committing', async () => {
    mocks.charge.mockRejectedValue(new Error('OVER_TENDER'));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Charge Rs 1500.00 on terminal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Payment was not sent\./);
    expect(screen.getByRole('button', { name: 'Charge Rs 1500.00 on terminal' })).toBeEnabled();
  });

  it('disables the charge while the bill cannot take a payment', () => {
    renderPanel({ disabled: true });
    expect(screen.getByRole('button', { name: 'Charge Rs 1500.00 on terminal' })).toBeDisabled();
  });

  it("never carries one bill's terminal result onto the next bill", async () => {
    mocks.charge.mockImplementation(async () => {
      mocks.latest = view({ phase: 'UNKNOWN', open: true, canCheckStatus: true });
      return mocks.latest;
    });
    const { rerender, onSettled } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Charge Rs 1500.00 on terminal' }));
    await screen.findByRole('button', { name: 'Check status' });
    // The overlay stays mounted while the counter moves to another bill with no attempt.
    mocks.latest = null;
    rerender(
      <CounterCardTerminalPanel
        branchId="branch-1"
        saleId="sale-2"
        deviceId="counter-device-1"
        balanceMinor={150_000}
        businessDate={() => new Date('2026-11-18T00:00:00.000Z')}
        onSettled={onSettled}
      />
    );
    expect(screen.queryByText(/the customer may have been charged/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge Rs 1500.00 on terminal' })).toBeEnabled();
  });
});
