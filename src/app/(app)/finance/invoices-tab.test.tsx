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

describe('CreateInvoiceForm tax and discount (#448)', () => {
  beforeEach(() => {
    mocks.mutate.mockClear();
  });

  const total = (label: string) =>
    screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

  function fill(lines: Array<[string, string, string]>) {
    const { container } = render(<CreateInvoiceForm onClose={vi.fn()} />);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'client-1' } });
    fireEvent.change(container.querySelector('input[type="date"]')!, {
      target: { value: '2026-11-30' },
    });
    lines.forEach(([description, quantity, rate], index) => {
      if (index > 0) fireEvent.click(screen.getByRole('button', { name: 'Add line item' }));
      fireEvent.change(screen.getAllByPlaceholderText('Description')[index], {
        target: { value: description },
      });
      fireEvent.change(screen.getAllByPlaceholderText('Qty')[index], {
        target: { value: quantity },
      });
      fireEvent.change(screen.getAllByPlaceholderText('Rate')[index], { target: { value: rate } });
    });
  }

  it('previews and submits the cent-exact amounts the server will persist', () => {
    fill([
      ['Pack', '3', '0.335'],
      ['Retainer', '2', '19.995'],
    ]);
    fireEvent.change(screen.getByLabelText('Discount (USD)'), { target: { value: '1.005' } });
    fireEvent.change(screen.getByLabelText('Tax (USD)'), { target: { value: '3.335' } });

    expect(screen.getByText('$1.01', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('$39.99', { selector: 'span' })).toBeInTheDocument();
    expect(total('Subtotal')).toBe('$41');
    expect(total('Discount')).toBe('−$1.01');
    expect(total('Tax')).toBe('$3.34');
    expect(total('Total')).toBe('$43.33');

    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));

    expect(mocks.mutate).toHaveBeenCalledOnce();
    const sent = mocks.mutate.mock.calls[0][0];
    expect(sent).toMatchObject({
      clientId: 'client-1',
      items: [
        { description: 'Pack', quantity: 3, rate: 0.335, amount: 1.01 },
        { description: 'Retainer', quantity: 2, rate: 19.995, amount: 39.99 },
      ],
      discount: 1.01,
      tax: 3.34,
    });
    expect(sent).not.toHaveProperty('subtotal');
    expect(sent).not.toHaveProperty('total');
  });

  it('sends zero tax and discount when both are left blank', () => {
    fill([['Consulting', '1', '100']]);

    expect(total('Total')).toBe('$100');
    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));

    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ discount: 0, tax: 0 }));
  });

  it('flags a discount above the subtotal and refuses to submit it', () => {
    fill([['Consulting', '1', '100']]);
    const discount = screen.getByLabelText('Discount (USD)');
    fireEvent.change(discount, { target: { value: '100.01' } });

    const error = screen.getByText('Discount cannot be more than the subtotal.');
    expect(discount).toHaveAttribute('aria-invalid', 'true');
    expect(discount).toHaveAttribute('aria-describedby', error.id);
    expect(total('Subtotal')).toBe('$100');
    expect(total('Total')).toBe('—');
    const submit = screen.getByRole('button', { name: 'Create Invoice' });
    expect(submit).toBeDisabled();

    fireEvent.click(submit);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
