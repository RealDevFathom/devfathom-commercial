import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CounterOpenBills, type CounterOpenBill } from './counter-open-bills';
import { CounterVoidDialog } from './counter-void-dialog';
import { CounterOpenDrawerStep } from './counter-open-drawer-step';

const bill: CounterOpenBill = {
  saleId: 'synthetic-sale',
  status: 'HELD',
  createdAt: '2026-01-01T00:00:00Z',
  openedBy: null,
  lineCount: 1,
  reservedUnits: 1,
  netMinor: 100,
  tenderedMinor: 0,
  customerOrder: false,
};

describe('DEV-41 remaining disabled explanations in dialogs', () => {
  it.each([false, true])('explains busy open-bill actions including a paid bill: %s', (paid) => {
    const onResume = vi.fn();
    const onVoid = vi.fn();
    render(
      <CounterOpenBills
        bills={[{ ...bill, tenderedMinor: paid ? 50 : 0 }]}
        loading={false}
        error={null}
        activeSaleId={null}
        disabled
        onRefresh={vi.fn()}
        onResume={onResume}
        onVoid={onVoid}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Open bills/ }));
    const list = screen.getByRole('list', { name: 'Open and held bills' });
    for (const name of ['Resume', 'Void']) {
      const button = within(list).getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(
        expect.stringContaining(
          'Wait for the current counter action to finish or review payment status.'
        )
      );
      fireEvent.click(button);
    }
    if (paid)
      expect(within(list).getByRole('button', { name: 'Void' })).toHaveAccessibleDescription(
        expect.stringContaining('must refund it')
      );
    expect(onResume).not.toHaveBeenCalled();
    expect(onVoid).not.toHaveBeenCalled();
  });

  it('explains why the current bill cannot be resumed again', () => {
    render(
      <CounterOpenBills
        bills={[bill]}
        loading={false}
        error={null}
        activeSaleId={bill.saleId}
        disabled={false}
        onRefresh={vi.fn()}
        onResume={vi.fn()}
        onVoid={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Open bills/ }));
    expect(screen.getByRole('button', { name: 'On this counter' })).toHaveAccessibleDescription(
      'This bill is already on this counter.'
    );
    expect(screen.getByRole('button', { name: 'Void' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Void' })).not.toHaveAccessibleDescription();
  });

  it('explains the required void reason, including Other, then clears the explanation', () => {
    const onConfirm = vi.fn();
    render(<CounterVoidDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    const button = screen.getByRole('button', { name: 'Void bill' });
    expect(button).toHaveAccessibleDescription('Choose a reason before voiding this bill.');
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    expect(button).toHaveAccessibleDescription('Describe the reason before voiding this bill.');
    fireEvent.change(screen.getByLabelText('Describe the reason'), {
      target: { value: 'Duplicate entry' },
    });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAccessibleDescription();
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ code: 'OTHER', note: 'Duplicate entry' });
  });

  it('explains a pending void', () => {
    render(<CounterVoidDialog open busy onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Void bill' })).toHaveAccessibleDescription(
      'Wait for the current counter action to finish.'
    );
  });

  it('explains a pending drawer and removes descriptions when available', () => {
    const view = render(<CounterOpenDrawerStep disabled onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open drawer' })).toHaveAccessibleDescription(
      'Wait for the current counter action to finish.'
    );
    view.rerender(<CounterOpenDrawerStep disabled={false} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open drawer' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open drawer' })).not.toHaveAccessibleDescription();
  });
});

describe('DEV-41 remaining disabled explanations for unavailable storage', () => {
  it('gives an actionable storage reason instead of an indefinite wait', () => {
    render(<CounterOpenDrawerStep disabled deviceUnavailable onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open drawer' })).toHaveAccessibleDescription(
      'Allow site storage for this site, then reload before opening the drawer.'
    );
  });
});
