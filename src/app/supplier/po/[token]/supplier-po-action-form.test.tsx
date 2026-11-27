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
      buyerBranch: { name: 'Buyer branch', phone: '555-0100' },
      lines: [
        { id: 'line', lineNumber: 1, medicine: { productName: 'Test medicine' }, orderedPacks: 4 },
      ],
    },
  });
  render(<SupplierPoActionForm token="synthetic" />);
  expect(screen.getByText(/Buyer branch.*555-0100/)).toBeVisible();
  expect(screen.getByText(/Test medicine/)).toBeInTheDocument();
  expect(screen.getByRole('spinbutton')).toHaveValue(4);
  expect(screen.getByRole('button', { name: 'Confirm order' })).toBeEnabled();
});

it('explains an empty order and keeps delivery and substitution actions disabled until filled', () => {
  query.mockReturnValue({
    data: { buyerBranch: { name: 'Buyer branch', phone: null }, reference: 'PO-empty', lines: [] },
  });
  render(<SupplierPoActionForm token="synthetic" />);
  expect(screen.getByText(/there are no items on this order/i)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Send delivery date' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send substitution proposal' })).toBeDisabled();
});
it('shows progress while checking the link', () => {
  query.mockReturnValue({ isLoading: true });
  render(<SupplierPoActionForm token="synthetic" />);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Loading purchase order');
});

it.each([
  { data: { code: 'TOO_MANY_REQUESTS' } },
  { meta: { response: new Response(null, { status: 429 }) } },
])('shows retry guidance for a rate-limited page lookup', (error) => {
  query.mockReturnValue({ error });
  render(<SupplierPoActionForm token="synthetic" />);
  expect(
    screen.getByText('Too many tries. Wait a few minutes and open the link again.')
  ).toBeVisible();
  expect(screen.queryByText('This link is not valid')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
