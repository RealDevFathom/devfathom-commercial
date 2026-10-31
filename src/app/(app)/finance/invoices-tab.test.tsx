import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateInvoiceForm } from './invoices-tab';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ finance: { getInvoices: { invalidate: mocks.invalidate } } }),
    clients: { getAll: { useQuery: () => ({ data: [{ id: 'client-1', name: 'Acme' }] }) } },
    projects: { getAll: { useQuery: () => ({ data: [] }) } },
    finance: {
      createInvoice: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
    },
  },
}));

describe('CreateInvoiceForm', () => {
  beforeEach(() => {
    mocks.mutate.mockClear();
  });

  it('keeps the only line item and prevents an empty invoice submission', () => {
    render(<CreateInvoiceForm onClose={vi.fn()} />);

    const removeButton = screen.getByRole('button', { name: 'Remove line item' });
    expect(removeButton).toBeDisabled();

    fireEvent.click(removeButton);
    expect(screen.getByPlaceholderText('Description')).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('allows a line item to be removed when another line remains', () => {
    render(<CreateInvoiceForm onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add line item' }));
    const removeButtons = screen.getAllByRole('button', { name: 'Remove line item' });
    expect(removeButtons).toHaveLength(2);
    expect(removeButtons[0]).toBeEnabled();

    fireEvent.click(removeButtons[0]);
    expect(screen.getAllByPlaceholderText('Description')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove line item' })).toBeDisabled();
  });

  it('accepts a full discount on decimal lines and submits the displayed cents', () => {
    const { container } = render(<CreateInvoiceForm onClose={vi.fn()} />);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'client-1' } });
    fireEvent.change(container.querySelector('input[type="date"]')!, {
      target: { value: '2026-12-01' },
    });
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'First' } });
    fireEvent.change(screen.getByPlaceholderText('Rate'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add line item' }));
    fireEvent.change(screen.getAllByPlaceholderText('Description')[1], {
      target: { value: 'Second' },
    });
    fireEvent.change(screen.getAllByPlaceholderText('Rate')[1], { target: { value: '0.7' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tax', exact: true }), {
      target: { value: '0.005' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Discount', exact: true }), {
      target: { value: '0.8' },
    });

    expect(screen.getByText('$0.01')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Invoice', exact: true })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice', exact: true }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 0.8, tax: 0.01, discount: 0.8, total: 0.01 })
    );
  });

  it('associates invalid adjustment fields with their error and prevents submission', () => {
    render(<CreateInvoiceForm onClose={vi.fn()} />);
    const discount = screen.getByRole('spinbutton', { name: 'Discount', exact: true });
    fireEvent.change(discount, { target: { value: '1' } });
    expect(discount).toHaveAttribute('aria-invalid', 'true');
    expect(discount).toHaveAccessibleDescription('Discount cannot exceed the invoice subtotal');
    expect(screen.getByRole('button', { name: 'Create Invoice', exact: true })).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
