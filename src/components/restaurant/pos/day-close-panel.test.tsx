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
          readiness: { openBillCount: 0, openDrawerCount: 0 },
          existingCloseId: 'close-1',
          totals: {
            grossSales: '10.00',
            netSales: '10.00',
            cashExpected: '10.00',
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
      expect(within(dialog).getByLabelText('Business date')).toHaveValue('2026-08-19')
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check readiness' }));
    await within(dialog).findByText('Closed day');

    const manager = within(dialog).getByLabelText('Approving manager');
    expect(within(manager).queryByRole('option', { name: /Ari Cashier/ })).not.toBeInTheDocument();
    fireEvent.change(manager, { target: { value: 'manager-1' } });
    fireEvent.change(within(dialog).getByLabelText('Correction reason'), {
      target: { value: 'Count verified' },
    });
    fireEvent.change(within(dialog).getByLabelText('Manager PIN'), {
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
