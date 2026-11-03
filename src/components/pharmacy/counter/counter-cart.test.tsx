import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CounterCart } from '@/lib/pharmacy/counter';
import { counterAlertsFor } from '@/lib/pharmacy/counter-alerts';

import {
  CounterCartPanel,
  CounterLotOverride,
  nearExpiryDays,
  type CounterLotOption,
  type CounterLotOverrideProps,
} from './counter-cart';

const NOW = new Date('2026-09-29T00:00:00.000Z');
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

function cart(expiries: string[]): CounterCart {
  return {
    saleId: 'sale-a',
    status: 'OPEN',
    receiptNumber: null,
    lines: [
      {
        saleLineId: 'line-a',
        medicineId: 'medicine-a',
        medicineName: 'Synthetic tablet',
        strength: null,
        presentation: 'Tablet',
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnits: 10,
        unitPriceMinor: 2500,
        proRataCeilingMinor: 2500,
        discountMinor: 0,
        lineTotalMinor: 2500,
        rx: false,
        controlled: false,
        restricted: false,
        highAlert: false,
        lasa: false,
        coldChain: false,
        emergencySupply: false,
        allocations: expiries.map((expiresAt, index) => ({
          inventoryLotId: `lot-${index}`,
          batchNumber: `B-${index}`,
          expiresAt,
          canonicalUnits: 5,
          stockLocationCode: 'STORE-1',
          overridden: index > 0,
        })),
      },
    ],
    totals: { grossMinor: 2500, discountMinor: 0, netMinor: 2500, tenderedMinor: 0 },
  };
}

describe('nearExpiryDays', () => {
  it.each([
    [0, 0],
    [45, 45],
    [89, 89],
    [90, null],
    [365, null],
    [-1, null],
  ])('%i days out → %s', (days, expected) => {
    expect(nearExpiryDays(inDays(days), NOW)).toBe(expected);
  });
});

describe('CounterCartPanel', () => {
  it('renders five table columns with the actual selling unit, quantity, price, and net amount', () => {
    const value = cart([inDays(400)]);
    value.lines[0] = {
      ...value.lines[0]!,
      quantity: 2,
      canonicalUnits: 20,
      discountMinor: 300,
      lineTotalMinor: 4700,
    };
    render(<CounterCartPanel cart={value} state="ready" onRetry={vi.fn()} now={NOW} />);
    const table = screen.getByRole('table', { name: 'Cart lines' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent)
    ).toEqual(['#', 'Medicine', 'Unit × qty', 'Batch · Expiry', 'Amount']);
    const row = within(table)
      .getByRole('rowheader', { name: /Synthetic tablet/ })
      .closest('tr')!;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    ).toEqual(['1', '2 × strip20 units', expect.stringContaining('Batch B-0'), '47.00']);
    expect(within(row).getByRole('rowheader')).toHaveTextContent(
      'Tablet · strip · 20 units @ 25.00 · less 3.00'
    );
    expect(within(row).getByRole('list')).toHaveTextContent('Rack STORE-1');
    expect(screen.queryByText('Gross')).toBeNull();
    expect(screen.queryByText('Tendered')).toBeNull();
    expect(screen.queryByText('Balance')).toBeNull();
  });

  it('renders actual line-specific notes and safety remedies once, without treating expiry as FEFO', () => {
    const value = cart([inDays(30)]);
    const line = value.lines[0]!;
    line.rx = true;
    line.allocations[0]!.overridden = true;
    const alerts = counterAlertsFor(
      [
        {
          ref: line.saleLineId,
          medicine: { ...line, displayName: line.medicineName },
          blocked: [],
          prescription: null,
          requestedCanonicalUnits: line.canonicalUnits,
          nearestSafeExpiry: new Date(inDays(30)),
          discountMinor: line.discountMinor,
        },
        {
          ref: 'another-line',
          medicine: { ...line, medicineId: 'another-medicine', displayName: 'Another medicine' },
          blocked: [],
          prescription: null,
          requestedCanonicalUnits: 1,
          nearestSafeExpiry: null,
          discountMinor: 0,
        },
      ],
      { at: NOW }
    );
    render(
      <CounterCartPanel cart={value} state="ready" onRetry={vi.fn()} alerts={alerts} now={NOW} />
    );
    const note = screen.getByText('Synthetic tablet dispenses from a batch expiring in 30 day(s).');
    expect(note.parentElement?.parentElement).toHaveTextContent(
      'Tell the customer the expiry before completing the sale.'
    );
    expect(note.closest('[role="alert"]')).toBeNull();
    expect(screen.getAllByText('Commercial')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic tablet requires a prescription');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Attach a captured prescription and have a pharmacist verify it.'
    );
    expect(screen.queryByText(/Another medicine/)).toBeNull();
    expect(screen.queryByText('FEFO')).toBeNull();
    expect(screen.getByText('Batch override')).toBeInTheDocument();
  });

  it('keeps loading, unopened, empty, and retry states actionable', () => {
    const retry = vi.fn();
    const { rerender } = render(<CounterCartPanel cart={null} state="idle" onRetry={retry} />);
    expect(screen.getByText(/No bill is open/)).toBeInTheDocument();
    rerender(<CounterCartPanel cart={null} state="loading" onRetry={retry} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the bill');
    rerender(<CounterCartPanel cart={{ ...cart([]), lines: [] }} state="ready" onRetry={retry} />);
    expect(screen.getByText(/Scan or search a medicine/)).toBeInTheDocument();
    rerender(
      <CounterCartPanel cart={null} state="error" error="Connection lost." onRetry={retry} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('shows batch, expiry and a near-expiry warning only on the batch under 90 days', () => {
    render(
      <CounterCartPanel
        cart={cart([inDays(30), inDays(400)])}
        state="ready"
        onRetry={vi.fn()}
        now={NOW}
      />
    );
    const allocation = screen.getByRole('list', { name: 'Batch allocation for Synthetic tablet' });
    const [first, second] = within(allocation).getAllByRole('listitem');
    expect(first).toHaveTextContent('Batch B-0');
    expect(first).toHaveTextContent('FEFO');
    expect(first).toHaveTextContent('Near expiry · 30 d');
    expect(second).toHaveTextContent('Batch B-1');
    expect(second).toHaveTextContent('Batch override');
    expect(second).not.toHaveTextContent('Near expiry');
  });

  it('wraps medicine metadata and keeps every safety badge separate from it', () => {
    const value = cart([inDays(400)]);
    value.lines[0] = {
      ...value.lines[0]!,
      presentation: 'A presentation long enough to wrap beside a price',
      controlled: true,
      rx: true,
      restricted: true,
      lasa: true,
      highAlert: true,
      coldChain: true,
    };
    render(<CounterCartPanel cart={value} state="ready" onRetry={vi.fn()} now={NOW} />);
    const sale = screen.getByText(/A presentation long enough/);
    expect(sale.tagName).toBe('P');
    expect(sale).not.toHaveClass('truncate');
    expect(sale).not.toHaveTextContent('Controlled');
    for (const label of [
      'Controlled',
      'Prescription only',
      'Restricted',
      'Look-alike',
      'High alert',
      'Cold chain',
    ]) {
      const badge = screen.getByText(label);
      expect(badge.closest('p')).toBeNull();
      expect(badge.closest('[data-slot="status-pill"]')).toHaveClass('whitespace-nowrap');
    }
  });
});

const lots: CounterLotOption[] = [
  {
    inventoryLotId: 'lot-expired',
    batchNumber: 'OLD-1',
    expiresAt: inDays(-5),
    sellableUnits: 0,
    blockedBy: 'EXPIRED',
  },
  {
    inventoryLotId: 'lot-fefo',
    batchNumber: 'SOON-1',
    expiresAt: inDays(20),
    sellableUnits: 40,
    blockedBy: null,
  },
  {
    inventoryLotId: 'lot-later',
    batchNumber: 'LATE-1',
    expiresAt: inDays(500),
    sellableUnits: 100,
    blockedBy: null,
  },
];

function picker(overrides: Partial<CounterLotOverrideProps> = {}) {
  const props: CounterLotOverrideProps = {
    value: { inventoryLotId: null, reason: '' },
    lots,
    state: 'ready',
    now: NOW,
    onChange: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  render(<CounterLotOverride {...props} />);
  return props;
}

describe('CounterLotOverride', () => {
  it('is closed until the operator asks to sell a different batch', () => {
    const props = picker({ value: null });
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sell a different batch' }));
    expect(props.onChange).toHaveBeenCalledWith({ inventoryLotId: null, reason: '' });
  });

  it('preselects the earliest sellable lot as FEFO and disables blocked lots', () => {
    picker();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    const [expired, fefo, later] = radios as HTMLInputElement[];
    expect(expired).toBeDisabled();
    expect(expired!.closest('label')).toHaveTextContent('Expired');
    expect(fefo).toBeChecked();
    expect(fefo!.closest('label')).toHaveTextContent('FEFO');
    expect(fefo!.closest('label')).toHaveTextContent('Near expiry · 20 d');
    expect(later).not.toBeChecked();
    expect(later!.closest('label')).not.toHaveTextContent('Near expiry');
    // No override chosen yet, so no reason is asked for.
    expect(screen.queryByLabelText('Override reason')).toBeNull();
  });

  it('choosing a later lot selects it as the override', () => {
    const props = picker();
    const [, , later] = screen.getAllByRole('radio');
    fireEvent.click(later!);
    expect(props.onChange).toHaveBeenLastCalledWith({ inventoryLotId: 'lot-later', reason: '' });
  });

  it('asks for a required reason once a non-FEFO lot is selected', () => {
    const props = picker({ value: { inventoryLotId: 'lot-later', reason: '' } });
    const reason = screen.getByLabelText('Override reason');
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(reason, { target: { value: 'Customer asked for longer dating' } });
    expect(props.onChange).toHaveBeenLastCalledWith({
      inventoryLotId: 'lot-later',
      reason: 'Customer asked for longer dating',
    });
  });

  it('returning to the FEFO lot records no override', () => {
    const props = picker({ value: { inventoryLotId: 'lot-later', reason: 'x' } });
    const [, fefo] = screen.getAllByRole('radio');
    fireEvent.click(fefo!);
    expect(props.onChange).toHaveBeenLastCalledWith({ inventoryLotId: null, reason: 'x' });
  });

  it('Keep FEFO batch closes the override', () => {
    const props = picker({ value: { inventoryLotId: 'lot-later', reason: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep FEFO batch' }));
    expect(props.onChange).toHaveBeenLastCalledWith(null);
  });

  it('surfaces a load failure with a retry', () => {
    const props = picker({ state: 'error', error: 'Batches unavailable.', lots: [] });
    expect(screen.getByRole('alert')).toHaveTextContent('Batches unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });
});

it('shows cart brand above the generic and strength without changing money', () => {
  const value = cart([inDays(400)]);
  value.lines[0] = {
    ...value.lines[0]!,
    brandName: 'Panadol',
    medicineName: 'Paracetamol',
    strength: '500 mg',
  };
  render(<CounterCartPanel cart={value} state="ready" onRetry={vi.fn()} now={NOW} />);
  expect(screen.getByText('Paracetamol')).toHaveClass('block');
  expect(screen.getByRole('rowheader', { name: /Panadol/ })).toHaveTextContent(
    'Paracetamol'
  );
  expect(screen.getAllByText('25.00').length).toBeGreaterThan(0);
});
