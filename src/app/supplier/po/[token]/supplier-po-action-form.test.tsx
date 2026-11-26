import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SupplierPoActionForm } from './supplier-po-action-form';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySupplierLinks: { get: { useQuery: query }, submit: { useMutation: () => ({}) } },
  },
}));
afterEach(cleanup);
it('shows a single plain invalid-link page without order information', () => {
  query.mockReturnValue({ error: { data: { code: 'NOT_FOUND' } } });
  render(<SupplierPoActionForm token="synthetic" />);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('This link is not valid');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('names each ordered item and shows its quantity to the supplier', () => {
  query.mockReturnValue({
    data: {
      reference: 'PO-1',
      lines: [
        { id: 'line', lineNumber: 1, medicine: { productName: 'Test medicine' }, orderedPacks: 4 },
      ],
    },
  });
  render(<SupplierPoActionForm token="synthetic" />);
  expect(screen.getByText(/Test medicine/)).toBeInTheDocument();
  expect(screen.getByRole('spinbutton')).toHaveValue(4);
  expect(screen.getByRole('button', { name: 'Confirm order' })).toBeEnabled();
});
