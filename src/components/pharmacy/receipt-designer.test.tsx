import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
import { receiptDesign } from '@/lib/pharmacy/receipt-layout';
import { selectFieldControl } from '@/lib/testing/select-field';
const state = vi.hoisted(() => ({
  branches: {} as Record<string, unknown>,
  format: {} as Record<string, unknown>,
  save: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacySales: { counterReceiptFormat: { invalidate: state.invalidate, setData: vi.fn() } },
    }),
    pharmacySales: {
      counterBranches: { useQuery: () => state.branches },
      counterReceiptFormat: { useQuery: () => state.format },
      counterSaveReceiptFormat: {
        useMutation: () => ({ isPending: false, mutateAsync: state.save }),
      },
      counterUploadReceiptLogo: { useMutation: () => ({ isPending: false }) },
    },
  },
}));
import { PharmacyReceiptDesigner } from './receipt-designer';
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  state.branches = { data: { branches: [{ id: 'b', name: 'Branch B' }] } };
  state.format = { data: { revision: 2, layout: receiptDesign(null) } };
  state.save.mockReset();
  state.invalidate.mockClear();
});
it('preserves a conflicting draft until the administrator reviews the new revision', async () => {
  state.save.mockRejectedValueOnce({ data: { code: 'CONFLICT' } });
  const view = render(<PharmacyReceiptDesigner canSave />);
  const header = screen.getByRole('textbox', { name: /^Header$/ });
  fireEvent.change(header, { target: { value: 'My draft' } });
  const save = screen.getByRole('button', { name: 'Save design' });
  fireEvent.click(save);
  expect(await screen.findByText(/Another administrator saved changes/)).toBeVisible();
  expect(state.invalidate).toHaveBeenCalledWith({ branchId: 'b' });
  state.format = {
    data: { revision: 3, layout: { ...receiptDesign(null), headerText: 'New saved text' } },
  };
  view.rerender(<PharmacyReceiptDesigner canSave />);
  expect(header).toHaveValue('My draft');
  expect(save).toBeDisabled();
  fireEvent.change(selectFieldControl(screen.getByRole('combobox', { name: 'Preview version' })), {
    target: { value: 'saved' },
  });
  expect(screen.getByTitle('Sample receipt').getAttribute('srcdoc')).toContain('New saved text');
  fireEvent.click(screen.getByRole('button', { name: 'Use reviewed revision 3' }));
  expect(save).toBeEnabled();
  expect(screen.getByTitle('Sample receipt').getAttribute('srcdoc')).toContain('My draft');
  fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
  expect(header).toHaveValue('New saved text');
});
it('keeps read access separate from the admin-only design controls', () => {
  render(<PharmacyReceiptDesigner canSave={false} />);
  expect(screen.getByRole('textbox', { name: /^Header$/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Preview paper' })).toBeEnabled();
});
it('explains branch loading, empty, denied and failed reads', () => {
  state.branches = { isLoading: true };
  const view = render(<PharmacyReceiptDesigner canSave />);
  expect(screen.getByText('Loading branches…')).toBeVisible();
  state.branches = { data: { branches: [] } };
  view.rerender(<PharmacyReceiptDesigner canSave />);
  expect(screen.getByText('No active branch is available.')).toBeVisible();
  state.branches = { data: { branches: [{ id: 'b', name: 'Branch B' }] } };
  state.format = { isError: true, error: { data: { code: 'FORBIDDEN' } } };
  view.rerender(<PharmacyReceiptDesigner canSave />);
  expect(screen.getByRole('alert')).toHaveTextContent(/receipt access/);
  state.format = { isError: true };
  view.rerender(<PharmacyReceiptDesigner canSave />);
  expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/);
});
