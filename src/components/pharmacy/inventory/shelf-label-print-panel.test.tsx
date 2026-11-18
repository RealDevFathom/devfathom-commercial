import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ShelfLabelRow } from '@/lib/pharmacy/shelf-label';
import { shelfLabelCode } from '@/lib/pharmacy/shelf-label-code';

import { ShelfLabelPrintPanel } from './shelf-label-print-panel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sellable: ShelfLabelRow = {
  inventoryLotId: 'lot-a',
  code: shelfLabelCode(41),
  name: 'Paracetamol',
  strength: '500 mg',
  packMrpMinor: 12_000,
  stripMrpMinor: 1_200,
  expiry: '2027-06',
  batchNumber: 'B-1',
  defaultCount: 10,
  unavailableReason: null,
};
const recalled: ShelfLabelRow = {
  ...sellable,
  inventoryLotId: 'lot-b',
  code: shelfLabelCode(42),
  batchNumber: 'B-2',
  defaultCount: 2,
  unavailableReason: 'This batch is recalled.',
};

function fakePopup() {
  const written: string[] = [];
  const popup = {
    opener: {},
    closed: false,
    document: {
      open: vi.fn(),
      write: vi.fn((html: string) => written.push(html)),
      close: vi.fn(),
      querySelectorAll: vi.fn(() => []),
    },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(),
  };
  return { popup, written };
}

describe('DEV-90 shelf label print panel', () => {
  it('defaults to one label per received pack and never to an unsellable lot', () => {
    render(<ShelfLabelPrintPanel title="Goods receipt GRN-7" rows={[sellable, recalled]} />);
    expect(screen.getByLabelText('Labels for Paracetamol batch B-1')).toHaveValue('10');
    const blocked = screen.getByLabelText('Labels for Paracetamol batch B-2');
    expect(blocked).toHaveValue('0');
    expect(blocked).toBeDisabled();
    expect(screen.getByText('This batch is recalled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print 10 labels' })).toBeEnabled();
    expect(screen.getAllByText('Rs 120.00').length).toBeGreaterThan(0);
  });

  it('lets the operator change the count and prints exactly that many stickers', () => {
    const { popup, written } = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<ShelfLabelPrintPanel title="Search" rows={[sellable]} />);
    fireEvent.change(screen.getByLabelText('Labels for Paracetamol batch B-1'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Label size'), { target: { value: '50x25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));

    expect(written).toHaveLength(1);
    expect(written[0]!.match(/<section class="shelf-label"/g)).toHaveLength(3);
    expect(written[0]).toContain('@page { size: 50mm 25mm; margin: 0; }');
    expect(popup.opener).toBeNull();
    expect(popup.print).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('3 labels sent to the print dialog.');
  });

  it('blocks printing an invalid count', () => {
    render(<ShelfLabelPrintPanel title="Search" rows={[sellable]} />);
    fireEvent.change(screen.getByLabelText('Labels for Paracetamol batch B-1'), {
      target: { value: '2.5' },
    });
    expect(screen.getByRole('button', { name: /Print/ })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('whole number');
  });

  it('explains an empty result', () => {
    render(<ShelfLabelPrintPanel title="Search" rows={[]} />);
    expect(screen.getByText(/No lot with stock on hand/)).toBeInTheDocument();
  });
});
