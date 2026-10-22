import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SplitBillDialog, type BillSplit } from './split-bill-dialog';

describe('SplitBillDialog', () => {
  const items = [
    { id: 'item-1', name: 'Burger', quantity: 2, seatNumber: 1, modifiers: ['No onions'] },
    { id: 'item-2', name: 'Soup', quantity: 1, seatNumber: null, modifiers: [] },
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
    fireEvent.change(within(dialog).getByLabelText('Split method'), {
      target: { value: 'BY_SEAT' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create split bills' }));
    await waitFor(() => expect(onSplit).toHaveBeenLastCalledWith({ kind: 'BY_SEAT' }));

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    dialog = screen.getByRole('dialog', { name: 'Split bill' });
    fireEvent.change(within(dialog).getByLabelText('Split method'), {
      target: { value: 'FRACTIONAL' },
    });
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
    fireEvent.change(within(dialog).getByLabelText('Split method'), {
      target: { value: 'FRACTIONAL' },
    });
    fireEvent.change(within(dialog).getByLabelText('Fractional weights'), {
      target: { value: '1, 1.5' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create split bills' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('positive whole-number weights');
    expect(onSplit).not.toHaveBeenCalled();
  });

  it('shows recognizable order lines while keeping IDs in the submitted groups', async () => {
    const onSplit = vi.fn<(split: BillSplit) => Promise<boolean>>().mockResolvedValue(true);
    render(
      <SplitBillDialog
        items={[
          ...items,
          { id: 'item-3', name: 'Tea', quantity: 1, seatNumber: 2, modifiers: [] },
        ]}
        onSplit={onSplit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    const dialog = screen.getByRole('dialog', { name: 'Split bill' });
    expect(within(dialog).getByText('2 × Burger')).toBeVisible();
    expect(within(dialog).getByText('Seat 1 · No onions')).toBeVisible();
    expect(within(dialog).queryByText('item-1')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Bill for Tea'), {
      target: { value: '1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create split bills' }));
    await waitFor(() =>
      expect(onSplit).toHaveBeenCalledWith({
        kind: 'BY_ITEM',
        groups: [['item-1', 'item-3'], ['item-2']],
      })
    );
  });
});
