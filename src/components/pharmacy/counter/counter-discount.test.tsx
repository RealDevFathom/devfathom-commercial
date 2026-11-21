import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CounterDiscountEntry } from './counter-discount';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      discountMaximum: {
        useQuery: () => ({
          data: { maxDiscountBps: 1000 },
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
    },
  },
}));

function open(props: Partial<Parameters<typeof CounterDiscountEntry>[0]> = {}) {
  const onHold = vi.fn();
  render(
    <CounterDiscountEntry
      branchId="branch-a"
      held={null}
      disabled={false}
      onHold={onHold}
      onClear={vi.fn()}
      {...props}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discount' }));
  return { onHold };
}

describe('DEV-977 phase 3: the discount sheet\'s "Apply to" choice (A4)', () => {
  it('offers the next item and the whole bill when the owner has the whole-bill discount on', async () => {
    const apply = vi.fn().mockResolvedValue(null);
    const { onHold } = open({ wholeBill: { disabled: false, apply } });
    const sheet = screen.getByRole('dialog', { name: 'Discount on the next item' });
    const applyTo = within(sheet).getByRole('group', { name: 'Apply to' });
    expect(
      within(applyTo)
        .getAllByRole('button')
        .map((button) => [button.textContent, button.getAttribute('aria-pressed')])
    ).toEqual([
      ['Next item', 'true'],
      ['Whole bill', 'false'],
    ]);
    fireEvent.click(within(applyTo).getByRole('button', { name: 'Whole bill' }));
    const billSheet = screen.getByRole('dialog', { name: 'Discount on the whole bill' });
    const footer = billSheet.querySelector('[data-counter-sheet-foot]') as HTMLElement;
    expect(
      within(footer)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Cancel', 'Apply to bill']);
    fireEvent.change(within(billSheet).getByLabelText('Discount (%)'), {
      target: { value: '5' },
    });
    fireEvent.click(within(footer).getByRole('button', { name: 'Apply to bill' }));
    // The whole-bill procedure is the bill's own; nothing is held for the next item.
    await waitFor(() =>
      expect(apply).toHaveBeenCalledExactlyOnceWith(
        { kind: 'PERCENT', bps: 500 },
        '5% off the bill'
      )
    );
    expect(onHold).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Discount on the whole bill' })).toBeNull()
    );
  });

  it("keeps the sheet open with the server's refusal when the whole-bill discount is refused", async () => {
    const apply = vi
      .fn()
      .mockResolvedValue('This bill can take at most Rs 20.00 off. Give Rs 20.00 or less.');
    open({ wholeBill: { disabled: false, apply } });
    fireEvent.click(screen.getByRole('button', { name: 'Whole bill' }));
    fireEvent.click(screen.getByRole('button', { name: 'Amount (Rs)' }));
    fireEvent.change(screen.getByLabelText('Discount (Rs)'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to bill' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This bill can take at most Rs 20.00 off.'
    );
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      { kind: 'AMOUNT', minor: 5000 },
      'Rs 50.00 off the bill'
    );
    expect(screen.getByRole('dialog', { name: 'Discount on the whole bill' })).toBeInTheDocument();
  });

  it("checks the owner's maximum before sending a whole-bill percentage", () => {
    const apply = vi.fn();
    open({ wholeBill: { disabled: false, apply } });
    fireEvent.click(screen.getByRole('button', { name: 'Whole bill' }));
    fireEvent.change(screen.getByLabelText('Discount (%)'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to bill' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      "above the owner's maximum discount of 10%"
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it('cannot choose the whole bill once the bill has taken a payment', () => {
    open({ wholeBill: { disabled: true, apply: vi.fn() } });
    expect(screen.getByRole('button', { name: 'Whole bill' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next item' })).toBeEnabled();
  });

  it('applies to the next item, as before, where the whole-bill discount is off', () => {
    const { onHold } = open();
    expect(screen.queryByRole('group', { name: 'Apply to' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Discount (%)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to next item' }));
    expect(onHold).toHaveBeenCalledExactlyOnceWith({ kind: 'PERCENT', bps: 500 });
  });
});

describe('DEV-977 phase 3: the supervisor block in the discount sheet (A4)', () => {
  it('names who can approve with their own PIN, and asks for no PIN in the sheet', async () => {
    const onOpenChange = vi.fn();
    open({
      onOpenChange,
      approvers: {
        status: 'ready',
        list: [
          { id: 'staff-h', name: 'Hina Manager', self: false },
          { id: 'staff-o', name: 'Imran Owner', self: false },
        ],
      },
    });
    const block = screen.getByRole('region', { name: 'Supervisor approval' });
    expect(
      within(block)
        .getByText(/A manager or owner must approve a discount you cannot give on your own/)
        .closest('[data-counter-note]')
    ).toHaveAttribute('data-counter-note', 'warning');
    const who = await within(block).findByRole('list', { name: 'Who can approve' });
    expect(
      within(who)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['Hina Manager', 'Imran Owner']);
    expect(block).toHaveTextContent(/when you add the item/);
    // The approval itself stays in the counter's approval dialog.
    expect(within(block).queryByLabelText(/PIN/)).toBeNull();
    // The counter reads who can approve only while the sheet is open.
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('says a solo owner approves with their own PIN', async () => {
    open({
      approvers: { status: 'ready', list: [{ id: 'staff-o', name: 'Imran Owner', self: true }] },
    });
    const who = await screen.findByRole('list', { name: 'Who can approve' });
    expect(within(who).getByRole('listitem')).toHaveTextContent('Imran Owner (you)');
  });

  it('says when it applies to the whole bill', async () => {
    open({
      approvers: { status: 'ready', list: [] },
      wholeBill: { disabled: false, apply: vi.fn() },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Whole bill' }));
    expect(screen.getByRole('region', { name: 'Supervisor approval' })).toHaveTextContent(
      /when you apply it to the bill/
    );
  });

  it('says so when who can approve cannot be loaded, and still lets the discount be given', async () => {
    const { onHold } = open({ approvers: { status: 'error' } });
    expect(await screen.findByText(/Who can approve could not be loaded/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Discount (%)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to next item' }));
    expect(onHold).toHaveBeenCalledOnce();
  });

  it('says when nobody can approve at this till', async () => {
    open({ approvers: { status: 'ready', list: [] } });
    expect(
      await screen.findByText(/No manager or owner with an active staff PIN can approve here/)
    ).toBeInTheDocument();
  });
});
