import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalRequest, TerminalRequestOptions } from './checkout-panel';
import { DayClosePanel } from './day-close-panel';

const operators = [
  { id: 'operator-1', displayName: 'Ari Cashier', role: 'Cashier' },
  { id: 'manager-1', displayName: 'Mina Manager', role: 'Manager' },
];

describe('DayClosePanel', () => {
  it('loads the server business date and submits a correction with a selected manager', async () => {
    const calls: Array<{ path: string; options?: TerminalRequestOptions }> = [];
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) => {
      calls.push({ path, options });
      if (path.endsWith('/current')) return { businessDate: '2026-08-19' } as T;
      if (path.includes('/preview')) {
        return {
          businessDate: '2026-08-19',
          readiness: { openBillCount: 0, unresolvedOrderCount: 0, openDrawerCount: 0 },
          existingCloseId: 'close-1',
          totals: {
            grossSales: '10.00',
            deliveryFeeSales: '2.00',
            deliveryFeeRefunds: '0.50',
            netSales: '10.00',
            refundTotal: '0.00',
            cashExpected: '10.00',
            cashCounted: '10.00',
            cashVariance: '0.00',
          },
        } as T;
      }
      return {} as T;
    };

    render(<DayClosePanel request={request} operators={operators} actingOperatorId="operator-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close day' }));
    const dialog = screen.getByRole('dialog', { name: 'Close business day' });
    await waitFor(() =>
      expect(selectFieldControl(within(dialog).getByLabelText('Business date', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('2026-08-19')
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check readiness' }));
    await within(dialog).findByText('Closed day');
    expect(within(dialog).getByText('Delivery fee sales')).toBeVisible();
    expect(within(dialog).getByText('Delivery fee refunds')).toBeVisible();

    const manager = within(dialog).getByLabelText('Approving manager', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    expect(within(selectFieldControl(manager)).queryByRole('option', { hidden: true, name: /Ari Cashier/ })).not.toBeInTheDocument();
    fireEvent.change(selectFieldControl(manager), { target: { value: 'manager-1' } });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Correction reason', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Count verified' },
    });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Manager PIN', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '5678' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record correction' }));

    await waitFor(() => expect(calls.some(({ path }) => path.endsWith('/correct'))).toBe(true));
    expect(calls.find(({ path }) => path.endsWith('/correct'))?.options?.body).toEqual({
      businessDate: '2026-08-19',
      supersedesCloseId: 'close-1',
      reason: 'Count verified',
      approving: { staffProfileId: 'manager-1', type: 'PIN', secret: '5678' },
    });
  });

  it('shows counted cash, cash variance and refunds beside cash expected after close', async () => {
    const request: TerminalRequest = async <T,>(path: string) => {
      if (path.endsWith('/current')) return { businessDate: '2026-09-28' } as T;
      return {
        businessDate: '2026-09-28',
        readiness: { openBillCount: 0, unresolvedOrderCount: 0, openDrawerCount: 0 },
        existingCloseId: 'close-1',
        totals: {
          grossSales: '28.00',
          netSales: '14.00',
          deliveryFeeSales: '0.00',
          deliveryFeeRefunds: '0.00',
          refundTotal: '14.00',
          cashExpected: '100.00',
          cashCounted: '99.50',
          cashVariance: '-0.50',
        },
      } as T;
    };

    render(<DayClosePanel request={request} operators={operators} actingOperatorId="operator-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close day' }));
    const dialog = screen.getByRole('dialog', { name: 'Close business day' });
    await waitFor(() =>
      expect(selectFieldControl(within(dialog).getByLabelText('Business date', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('2026-09-28')
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check readiness' }));
    await within(dialog).findByText('Closed day');

    const value = (label: string) => within(dialog).getByText(label).nextElementSibling;
    expect(value('Cash expected')).toHaveTextContent('100.00');
    expect(value('Cash counted')).toHaveTextContent('99.50');
    expect(value('Cash variance')).toHaveTextContent('-0.50');
    expect(value('Refunds')).toHaveTextContent('14.00');
    expect(value('Net sales')).toHaveTextContent('14.00');
  });

  it.each([null, 'close-1'])(
    'blocks active orders without bills and restores the form after resolution (existing close: %s)',
    async (existingCloseId) => {
      let unresolvedOrderCount = 2;
      const request: TerminalRequest = async <T,>(path: string) => {
        if (path.endsWith('/current')) return { businessDate: '2026-09-28' } as T;
        return {
          businessDate: '2026-09-28',
          readiness: { openBillCount: 0, unresolvedOrderCount, openDrawerCount: 0 },
          existingCloseId,
          totals: {
            grossSales: '0.00',
            netSales: '0.00',
            deliveryFeeSales: '0.00',
            deliveryFeeRefunds: '0.00',
            refundTotal: '0.00',
            cashExpected: '0.00',
            cashCounted: '0.00',
            cashVariance: '0.00',
          },
        } as T;
      };

      render(
        <DayClosePanel request={request} operators={operators} actingOperatorId="operator-1" />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Close day' }));
      const dialog = screen.getByRole('dialog', { name: 'Close business day' });
      await waitFor(() =>
        expect(selectFieldControl(within(dialog).getByLabelText('Business date', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('2026-09-28')
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'Check readiness' }));
      await within(dialog).findByText('Close blocked');

      const value = (label: string) => within(dialog).getByText(label).nextElementSibling;
      expect(value('Active orders')).toHaveTextContent('2');
      expect(value('Open bills')).toHaveTextContent('0');
      expect(value('Open drawers')).toHaveTextContent('0');
      expect(within(dialog).getByText('blocked')).toBeVisible();
      expect(
        within(dialog).getByText('Resolve 2 active order(s), 0 open bill(s) and 0 open drawer(s).')
      ).toBeVisible();
      const action = existingCloseId ? 'Record correction' : 'Close business day';
      expect(within(dialog).queryByRole('button', { name: action })).not.toBeInTheDocument();
      expect(within(dialog).queryByLabelText('Manager PIN', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();

      unresolvedOrderCount = 0;
      fireEvent.click(within(dialog).getByRole('button', { name: 'Check readiness' }));
      expect(await within(dialog).findByRole('button', { name: action })).toBeEnabled();
      expect(value('Active orders')).toHaveTextContent('0');
      expect(within(dialog).queryByText('Close blocked')).not.toBeInTheDocument();
    }
  );

  it('shows a recoverable error and preserves keyboard dismissal', async () => {
    const request = vi.fn(async () => {
      throw new Error('Day date unavailable.');
    });
    render(
      <DayClosePanel
        request={request as TerminalRequest}
        operators={operators}
        actingOperatorId="operator-1"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close day' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Day date unavailable.');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('DayClosePanel manual card line', () => {
  const totals = {
    grossSales: '10.00',
    deliveryFeeSales: '0.00',
    deliveryFeeRefunds: '0.00',
    netSales: '10.00',
    refundTotal: '0.00',
    cashExpected: '0.00',
    cashCounted: '0.00',
    cashVariance: '0.00',
  };
  const figures = {
    count: 3,
    amount: '75.25',
    tipAmount: '0.00',
    refundCount: 0,
    refundAmount: '0.00',
    tipRefundAmount: '0.00',
    netAmount: '75.25',
    netTipAmount: '0.00',
  };
  async function openPreview(manualCardSummary: unknown) {
    const request: TerminalRequest = async <T,>(path: string) => {
      if (path.endsWith('/current')) return { businessDate: '2026-08-19' } as T;
      return {
        businessDate: '2026-08-19',
        readiness: { openBillCount: 0, unresolvedOrderCount: 0, openDrawerCount: 0 },
        existingCloseId: null,
        totals,
        manualCardSummary,
      } as T;
    };
    render(<DayClosePanel request={request} operators={operators} actingOperatorId="operator-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close day' }));
    const dialog = screen.getByRole('dialog', { name: 'Close business day' });
    await waitFor(() =>
      expect(selectFieldControl(within(dialog).getByLabelText('Business date', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('2026-08-19')
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check readiness' }));
    return dialog;
  }

  it('shows the Card, confirmed manually line with count, total and cashier rows', async () => {
    const dialog = await openPreview({
      ...figures,
      cashiers: [
        // Not in the approver-only operators list: the frozen name must still show.
        { ...figures, staffProfileId: 'cashier-9', displayName: 'Former Cashier' },
      ],
    });
    const region = await within(dialog).findByRole('region', { name: 'Card, confirmed manually' });
    expect(within(region).getAllByText('75.25').length).toBeGreaterThan(0);
    expect(within(region).getAllByText('3').length).toBeGreaterThan(0);
    expect(within(region).getByText('Former Cashier')).toBeVisible();
    expect(within(region).queryByText('cashier-9')).not.toBeInTheDocument();
  });

  it('distinguishes a zero-activity day from a close without a recorded breakdown', async () => {
    const zero = await openPreview({ ...figures, count: 0, amount: '0.00', cashiers: [] });
    expect(await within(zero).findByText('No manually confirmed card activity.')).toBeVisible();
  });

  it('says the breakdown was not recorded when the summary is null', async () => {
    const dialog = await openPreview(null);
    expect(await within(dialog).findByText(/was not recorded/)).toBeVisible();
  });
});
