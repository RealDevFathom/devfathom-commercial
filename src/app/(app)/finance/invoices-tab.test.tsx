import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateInvoiceForm, InvoicesTab } from './invoices-tab';
import type { InvoiceStatusValue } from '@/lib/finance/invoice-status';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  status: 'PAID' as InvoiceStatusValue,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 65,
    getVirtualItems: () => [{ index: 0, start: 0 }],
    measureElement: vi.fn(),
  }),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ finance: { getInvoices: { invalidate: mocks.invalidate } } }),
    clients: { getAll: { useQuery: () => ({ data: [{ id: 'client-1', name: 'Acme' }] }) } },
    projects: { getAll: { useQuery: () => ({ data: [] }) } },
    finance: {
      getInvoices: {
        useQuery: () => ({
          data: [
            {
              id: 'invoice-1',
              invoiceNumber: 'INV-1',
              status: mocks.status,
              currency: 'USD',
              total: 100,
              dueDate: '2026-11-01',
              client: { name: 'Acme' },
              project: null,
            },
          ],
          isLoading: false,
        }),
      },
      updateInvoiceStatus: { useMutation: () => ({ mutate: mocks.mutate }) },
      createInvoice: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('invoice status menu placement', () => {
  function openMenu(status: InvoiceStatusValue, triggerTop: number, menuHeight: number) {
    mocks.status = status;
    vi.stubGlobal('innerHeight', 420);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const isTrigger = this.tagName === 'BUTTON';
      return {
        top: isTrigger ? triggerTop : 0,
        bottom: isTrigger ? triggerTop + 24 : menuHeight,
        left: 700,
        right: 780,
        width: 80,
        height: isTrigger ? 24 : menuHeight,
        x: 700,
        y: isTrigger ? triggerTop : 0,
        toJSON: () => ({}),
      };
    });
    render(<InvoicesTab />);
    const label = status[0] + status.slice(1).toLowerCase();
    fireEvent.click(screen.getByRole('button', { name: label }));
    return screen.getAllByRole('button', { name: 'Cancelled' }).at(-1)!.parentElement!;
  }

  it.each([
    ['DRAFT', 94],
    ['SENT', 122],
    ['PAID', 38],
    ['OVERDUE', 94],
    ['CANCELLED', 66],
  ] as const)(
    'anchors the %s menu above its trigger using its rendered height',
    (status, height) => {
      const menu = openMenu(status, 390, height);

      expect(menu).toHaveStyle({ top: `${390 - height - 4}px`, left: '740px' });
    }
  );

  it('opens a short menu below when its actual height fits', () => {
    const menu = openMenu('PAID', 350, 38);

    expect(menu).toHaveStyle({ top: '378px', left: '740px' });
  });
});

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
});

describe('invoice create adjustments', () => {
  beforeEach(() => mocks.mutate.mockClear());
  function fillForm() {
    const { container } = render(<CreateInvoiceForm onClose={vi.fn()} />);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'client-1' } });
    fireEvent.change(container.querySelector('input[type="date"]')!, {
      target: { value: '2026-12-01' },
    });
    fireEvent.change(screen.getByPlaceholderText('Description'), {
      target: { value: 'Consulting' },
    });
    fireEvent.change(screen.getByPlaceholderText('Rate'), { target: { value: '1.005' } });
  }
  it('previews and submits nonzero tax and discount with rounded amounts', () => {
    fillForm();
    fireEvent.change(screen.getByLabelText('Tax (USD)'), { target: { value: '0.005' } });
    fireEvent.change(screen.getByLabelText('Discount (USD)'), { target: { value: '0.005' } });
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$1.01');
    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        subtotal: 1.01,
        tax: 0.01,
        discount: 0.01,
        total: 1.01,
        items: [{ description: 'Consulting', quantity: 1, rate: 1.005, amount: 1.01 }],
      })
    );
  });
  it.each(['-1', '1.02', '10000000000'])(
    'blocks invalid discount %s and preserves its value',
    (discount) => {
      fillForm();
      fireEvent.change(screen.getByLabelText('Discount (USD)'), { target: { value: discount } });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByLabelText('Discount (USD)')).toHaveValue(Number(discount));
      expect(screen.getByRole('button', { name: 'Create Invoice' })).toBeDisabled();
      expect(mocks.mutate).not.toHaveBeenCalled();
    }
  );
});
