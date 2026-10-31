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
    fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
    return screen.getAllByRole('button', { name: 'Cancelled', exact: true }).at(-1)!.parentElement!;
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
