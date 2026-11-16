import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  decide: vi.fn(),
  queue: {
    data: [] as unknown[],
    isPending: false,
    error: null as null | { message: string; data: { code: string } },
  },
  search: { data: [{ id: 'medicine', productName: 'Soap' }], isFetching: false, error: null },
  pending: false,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyMedicine: {
        catalogueEdits: { invalidate: vi.fn() },
        search: { invalidate: vi.fn() },
      },
    }),
    pharmacyMedicine: {
      search: { useQuery: () => mocks.search },
      catalogueEdits: { useQuery: () => ({ ...mocks.queue, refetch: vi.fn() }) },
      submitCatalogueEdit: {
        useMutation: () => ({ mutate: mocks.submit, isPending: false, error: null }),
      },
      decideCatalogueEdit: {
        useMutation: () => ({ mutate: mocks.decide, isPending: mocks.pending, error: null }),
      },
    },
  },
}));
import { CatalogueEditQueue } from './catalogue-edit-queue';
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.queue = { data: [], isPending: false, error: null };
  mocks.pending = false;
});

it('submits an edit for review instead of changing the live item', () => {
  render(<CatalogueEditQueue />);
  fireEvent.click(screen.getByRole('button', { name: 'Soap' }));
  fireEvent.change(screen.getByLabelText('Proposed value'), { target: { value: 'Reviewed soap' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
  expect(mocks.submit).toHaveBeenCalledWith({
    medicineId: 'medicine',
    changes: { productName: 'Reviewed soap' },
  });
});

it('sends a fresh PIN with one approval and clears it before another action', () => {
  mocks.queue.data = [
    { id: 'edit', medicine: { productName: 'Soap' }, changes: { productName: 'New soap' } },
  ];
  render(<CatalogueEditQueue />);
  fireEvent.change(screen.getByLabelText('Solo-owner PIN (only for your own edit)'), {
    target: { value: '1234' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve edit' }));
  expect(mocks.decide).toHaveBeenCalledWith({ editId: 'edit', decision: 'APPROVE', pin: '1234' });
  expect(screen.getByLabelText('Solo-owner PIN (only for your own edit)')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Reject edit' }));
  expect(mocks.decide).toHaveBeenLastCalledWith({ editId: 'edit', decision: 'REJECT' });
});

it('shows loading, empty, denied and pending states', () => {
  mocks.queue.isPending = true;
  const view = render(<CatalogueEditQueue />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading pending edits');
  mocks.queue.isPending = false;
  view.rerender(<CatalogueEditQueue />);
  expect(screen.getByText('No catalogue edits await review.')).toBeVisible();
  mocks.queue.error = { message: 'Denied', data: { code: 'FORBIDDEN' } };
  view.rerender(<CatalogueEditQueue />);
  expect(screen.getByRole('alert')).toHaveTextContent('Catalogue review permission is required');
  mocks.queue.error = null;
  mocks.queue.data = [
    { id: 'edit', medicine: { productName: 'Soap' }, changes: { productName: 'New soap' } },
  ];
  mocks.pending = true;
  view.rerender(<CatalogueEditQueue />);
  expect(screen.getByRole('button', { name: 'Approve edit' })).toBeDisabled();
});
