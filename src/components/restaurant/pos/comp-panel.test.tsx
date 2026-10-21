import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompPanel } from './comp-panel';
import type { TerminalRequest } from './checkout-panel';
const props = {
  orderId: 'order',
  operators: [
    { id: 'actor', displayName: 'Actor', role: 'Cashier' },
    { id: 'manager', displayName: 'Manager', role: 'Manager' },
  ],
  actingOperatorId: 'actor',
  disabled: false,
  onApplied: vi.fn(async () => {}),
};
describe('compact register comp (#275)', () => {
  it('selects a bill line, excludes self approval, submits the reason and manager credential', async () => {
    const request = vi.fn(async (_path: string, options?: { method?: string }) =>
      options?.method === 'POST'
        ? {}
        : {
            lines: [
              { id: 'line', billId: 'bill', name: 'Coffee', quantity: 1, lineTotal: '44.00' },
            ],
          }
    );
    render(<CompPanel {...props} request={request as TerminalRequest} />);
    fireEvent.click(screen.getByRole('button', { name: /^Comp$/ }));
    fireEvent.change(await screen.findByLabelText('Bill line'), { target: { value: 'line' } });
    expect(screen.queryByRole('option', { name: 'Actor' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Comp reason'), { target: { value: ' Hospitality ' } });
    fireEvent.change(screen.getByLabelText('Approving manager'), { target: { value: 'manager' } });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm comp' }));
    await waitFor(() => expect(props.onApplied).toHaveBeenCalled());
    expect(request).toHaveBeenLastCalledWith('/api/restaurant/checkout/comp', {
      method: 'POST',
      intent: 'comp-line',
      body: {
        billId: 'bill',
        billLineId: 'line',
        reason: 'Hospitality',
        approving: { staffProfileId: 'manager', type: 'PIN', secret: '1234' },
      },
    });
  });
  it('shows permission errors and disables offline access', async () => {
    const { rerender } = render(
      <CompPanel
        {...props}
        request={vi.fn().mockRejectedValue(new Error('Permission denied: orders:complimentary'))}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Comp$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    rerender(<CompPanel {...props} disabled request={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Comp$/ })).toBeDisabled();
  });
});
