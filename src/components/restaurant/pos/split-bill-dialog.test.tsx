import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SplitBillDialog, type BillSplit } from './split-bill-dialog';

describe('SplitBillDialog', () => {
  const items = [
    { id: 'item-1', name: 'Burger', quantity: 1, seatNumber: 2, modifiers: ['No onions'] },
    { id: 'item-2', name: 'Soup', quantity: 2, seatNumber: null, modifiers: [] },
  ];

  it('submits by-item, by-seat, and fractional payloads', async () => {
    const onSplit = vi.fn<(split: BillSplit) => Promise<boolean>>().mockResolvedValue(true);
    render(<SplitBillDialog items={items} onSplit={onSplit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    let dialog = screen.getByRole('dialog', { name: 'Split bill' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create split bills' }));
    await waitFor(() =>
      expect(onSplit).toHaveBeenLastCalledWith({
        kind: 'BY_ITEM',
        groups: [['item-1'], ['item-2']],
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    dialog = screen.getByRole('dialog', { name: 'Split bill' });
    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Split method', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: 'BY_SEAT' },
      }
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create split bills' }));
    await waitFor(() => expect(onSplit).toHaveBeenLastCalledWith({ kind: 'BY_SEAT' }));

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    dialog = screen.getByRole('dialog', { name: 'Split bill' });
    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Split method', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: 'FRACTIONAL' },
      }
    );
    fireEvent.change(within(dialog).getByLabelText('Fractional weights'), {
      target: { value: '1, 2' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create split bills' }));
    await waitFor(() =>
      expect(onSplit).toHaveBeenLastCalledWith({ kind: 'FRACTIONAL', weights: [1, 2] })
    );
  });

  it('rejects fractional weights that are not positive integers', () => {
    const onSplit = vi.fn<(split: BillSplit) => Promise<boolean>>().mockResolvedValue(true);
    render(<SplitBillDialog items={items} onSplit={onSplit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    const dialog = screen.getByRole('dialog', { name: 'Split bill' });
    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Split method', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: 'FRACTIONAL' },
      }
    );
    fireEvent.change(within(dialog).getByLabelText('Fractional weights'), {
      target: { value: '1, 1.5' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create split bills' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('positive whole-number weights');
    expect(onSplit).not.toHaveBeenCalled();
  });

  it('shows recognizable order-line context while keeping IDs out of the interface', () => {
    render(<SplitBillDialog items={items} onSplit={vi.fn().mockResolvedValue(true)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));

    expect(screen.getByText('1 × Burger')).toBeVisible();
    expect(screen.getByText('Order line 1 · Seat 2 · No onions')).toBeVisible();
    expect(screen.getByText('2 × Soup')).toBeVisible();
    expect(screen.getByText('Order line 2 · No seat')).toBeVisible();
    expect(screen.queryByText(/item-1|item-2/)).not.toBeInTheDocument();
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Burger, order line 1', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('1');
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Soup, order line 2', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('2');
  });

  it('distinguishes otherwise identical order lines', () => {
    render(
      <SplitBillDialog
        items={[
          { id: 'item-1', name: 'Tea', quantity: 1, seatNumber: null, modifiers: ['Iced'] },
          { id: 'item-2', name: 'Tea', quantity: 1, seatNumber: null, modifiers: ['Iced'] },
        ]}
        onSplit={vi.fn().mockResolvedValue(true)}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));

    expect(screen.getByText('Order line 1 · No seat · Iced')).toBeVisible();
    expect(screen.getByText('Order line 2 · No seat · Iced')).toBeVisible();
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Tea, order line 1', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('1');
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Tea, order line 2', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('2');
  });

  it('groups selected dishes while submitting only their internal IDs', async () => {
    const onSplit = vi.fn<(split: BillSplit) => Promise<boolean>>().mockResolvedValue(true);
    render(
      <SplitBillDialog
        items={[
          ...items,
          { id: 'item-3', name: 'Tea', quantity: 1, seatNumber: 2, modifiers: ['Iced'] },
        ]}
        onSplit={onSplit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Tea, order line 3', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: '1' },
      }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create split bills' }));

    await waitFor(() =>
      expect(onSplit).toHaveBeenCalledWith({
        kind: 'BY_ITEM',
        groups: [['item-1', 'item-3'], ['item-2']],
      })
    );
  });

  it('keeps visible guest bill numbers aligned with checkout after removing a group', async () => {
    const onSplit = vi.fn<(split: BillSplit) => Promise<boolean>>().mockResolvedValue(false);
    render(
      <SplitBillDialog
        items={[
          ...items,
          { id: 'item-3', name: 'Tea', quantity: 1, seatNumber: null, modifiers: [] },
        ]}
        onSplit={onSplit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Soup, order line 2', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: '1' },
      }
    );

    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Burger, order line 1', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('1');
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Soup, order line 2', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('1');
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Tea, order line 3', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('2');

    fireEvent.click(screen.getByRole('button', { name: 'Create split bills' }));
    await screen.findByRole('alert');
    expect(onSplit).toHaveBeenLastCalledWith({
      kind: 'BY_ITEM',
      groups: [['item-1', 'item-2'], ['item-3']],
    });
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Tea, order line 3', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('2');

    // Reassign to an unused number and retry: the displayed bill must still
    // match the one-based position of its submitted group.
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Tea, order line 3', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: '3' },
      }
    );
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Tea, order line 3', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'Create split bills' }));
    await waitFor(() => expect(onSplit).toHaveBeenCalledTimes(2));
    expect(onSplit).toHaveBeenLastCalledWith({
      kind: 'BY_ITEM',
      groups: [['item-1', 'item-2'], ['item-3']],
    });
  });

  it('resets visible assignments when the order lines change before submission', async () => {
    const onSplit = vi.fn<(split: BillSplit) => Promise<boolean>>().mockResolvedValue(true);
    const { rerender } = render(<SplitBillDialog items={items} onSplit={onSplit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Burger, order line 1', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: '2' },
      }
    );

    const refreshedItems = [
      items[0],
      { id: 'item-3', name: 'Tea', quantity: 1, seatNumber: 2, modifiers: ['Iced'] },
      { id: 'item-4', name: 'Cake', quantity: 1, seatNumber: null, modifiers: [] },
    ];
    rerender(<SplitBillDialog items={refreshedItems} onSplit={onSplit} />);

    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Burger, order line 1', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('1');
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Tea, order line 2', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('2');
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Cake, order line 3', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('3');

    fireEvent.click(screen.getByRole('button', { name: 'Create split bills' }));

    await waitFor(() =>
      expect(onSplit).toHaveBeenCalledWith({
        kind: 'BY_ITEM',
        groups: [['item-1'], ['item-3'], ['item-4']],
      })
    );
  });

  it('resets assignments when refreshed order lines are reordered before submission', async () => {
    const onSplit = vi.fn<(split: BillSplit) => Promise<boolean>>().mockResolvedValue(true);
    const { rerender } = render(<SplitBillDialog items={items} onSplit={onSplit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Burger, order line 1', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: '2' },
      }
    );

    rerender(<SplitBillDialog items={[items[1], items[0]]} onSplit={onSplit} />);

    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Soup, order line 1', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('1');
    expect(
      selectFieldControl(
        screen.getByLabelText('Guest bill for Burger, order line 2', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('2');

    fireEvent.click(screen.getByRole('button', { name: 'Create split bills' }));

    await waitFor(() =>
      expect(onSplit).toHaveBeenCalledWith({
        kind: 'BY_ITEM',
        groups: [['item-2'], ['item-1']],
      })
    );
  });
});
