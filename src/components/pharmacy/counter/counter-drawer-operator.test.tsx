import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CounterDrawerOperator } from './counter-drawer-operator';
import { CounterOpenDrawerStep } from './counter-open-drawer-step';

const cashiers = [
  { id: 'manager-1', name: 'Mehreen Shah' },
  { id: 'cashier-1', name: 'Bilal Ahmed' },
];

describe('CounterOpenDrawerStep: who runs the till (DEV-821)', () => {
  it('lets a manager open the till for a named cashier', () => {
    const onOpen = vi.fn();
    render(
      <CounterOpenDrawerStep
        disabled={false}
        cashiers={cashiers}
        currentUserId="manager-1"
        onOpen={onOpen}
      />
    );
    const select = screen.getByLabelText('Who runs this till');
    expect(select).toHaveValue('manager-1');
    expect(screen.getByRole('option', { name: 'Mehreen Shah (you)' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '5000' } });
    fireEvent.change(select, { target: { value: 'cashier-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(500000, 'cashier-1');
  });

  it('sends no cashier when the opener runs the till themselves', () => {
    const onOpen = vi.fn();
    render(
      <CounterOpenDrawerStep
        disabled={false}
        cashiers={cashiers}
        currentUserId="manager-1"
        onOpen={onOpen}
      />
    );
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(0, undefined);
  });

  it('offers a cashier no choice: they run the drawer they open', () => {
    const onOpen = vi.fn();
    render(<CounterOpenDrawerStep disabled={false} currentUserId="cashier-1" onOpen={onOpen} />);
    expect(screen.queryByLabelText('Who runs this till')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(0, undefined);
  });
});

describe('CounterDrawerOperator (DEV-821)', () => {
  it('shows nothing to the cashier who runs the till', () => {
    const { container } = render(
      <CounterDrawerOperator operatingCashier={{ name: 'Bilal Ahmed', isYou: true }} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("tells a cashier at a colleague's till to ask for a handover, offering none", () => {
    render(<CounterDrawerOperator operatingCashier={{ name: 'Bilal Ahmed', isYou: false }} />);
    expect(screen.getByRole('region')).toHaveTextContent(
      'Bilal Ahmed runs this cash drawer. Ask a manager or owner to hand it over to you before you take cash.'
    );
    expect(screen.queryByRole('button', { name: 'Hand over till' })).not.toBeInTheDocument();
  });

  it('lets a manager hand the till over with a reason, and requires both', async () => {
    const onHandover = vi.fn(async () => undefined);
    render(
      <CounterDrawerOperator
        operatingCashier={{ name: 'Mehreen Shah', isYou: true }}
        cashiers={cashiers}
        onHandover={onHandover}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hand over till' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the cashier and give a reason.');
    expect(screen.getByLabelText('Hand the till to')).toHaveAttribute('aria-invalid', 'true');
    expect(onHandover).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Hand the till to'), {
      target: { value: 'cashier-1' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: ' Shift change ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    expect(onHandover).toHaveBeenCalledExactlyOnceWith('cashier-1', 'Shift change');
    // Once recorded, the form closes.
    await waitFor(() =>
      expect(screen.queryByLabelText('Hand the till to')).not.toBeInTheDocument()
    );
  });

  it('keeps the form and its values when the server refuses the handover', async () => {
    const onHandover = vi.fn(async () => {
      throw new Error('CASHIER_NOT_ASSIGNED');
    });
    render(
      <CounterDrawerOperator
        operatingCashier={{ name: 'Bilal Ahmed', isYou: false }}
        cashiers={cashiers}
        onHandover={onHandover}
      />
    );
    expect(screen.getByRole('region')).toHaveTextContent(
      'As a manager or owner you can still take cash, or hand the till over.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hand over till' }));
    fireEvent.change(screen.getByLabelText('Hand the till to'), {
      target: { value: 'manager-1' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Cover' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    await waitFor(() => expect(onHandover).toHaveBeenCalled());
    expect(screen.getByLabelText('Reason')).toHaveValue('Cover');
  });

  it('closes the handover form on Escape', () => {
    render(
      <CounterDrawerOperator
        operatingCashier={{ name: 'Mehreen Shah', isYou: true }}
        cashiers={cashiers}
        onHandover={vi.fn(async () => undefined)}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hand over till' }));
    fireEvent.keyDown(screen.getByLabelText('Reason'), { key: 'Escape' });
    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();
  });
});
