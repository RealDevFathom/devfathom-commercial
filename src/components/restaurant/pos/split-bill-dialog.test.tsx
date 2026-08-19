import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SplitBillDialog, type BillSplit } from './split-bill-dialog';

describe('SplitBillDialog', () => {
  it('submits by-item, by-seat, and fractional payloads', async () => {
    const onSplit = vi.fn<(split: BillSplit) => Promise<boolean>>().mockResolvedValue(true);
    render(<SplitBillDialog itemIds={['item-1', 'item-2']} onSplit={onSplit} />);

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
});
