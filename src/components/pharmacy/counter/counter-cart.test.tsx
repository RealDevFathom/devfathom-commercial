import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CounterCart } from '@/lib/pharmacy/counter';

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

describe('CounterCartPanel FEFO chips', () => {
  it('shows batch, expiry and a near-expiry warning only on the batch under 90 days', () => {
    render(
      <CounterCartPanel
        cart={cart([inDays(30), inDays(400)])}
        state="ready"
        onRetry={vi.fn()}
        now={NOW}
      />
    );
    const allocation = screen.getByRole('list', { name: 'FEFO allocation for Synthetic tablet' });
    const [first, second] = within(allocation).getAllByRole('listitem');
    expect(first).toHaveTextContent('Batch B-0');
    expect(first).toHaveTextContent('FEFO');
    expect(first).toHaveTextContent('Near expiry · 30 d');
    expect(second).toHaveTextContent('Batch B-1');
    expect(second).toHaveTextContent('Batch override');
    expect(second).not.toHaveTextContent('Near expiry');
  });

  it('hides the batch map from a cashier but keeps override and near-expiry warnings', () => {
    render(
      <CounterCartPanel
        cart={cart([inDays(30), inDays(400)])}
        state="ready"
        onRetry={vi.fn()}
        showAllocation={false}
        now={NOW}
      />
    );
    expect(
      screen.queryByRole('list', { name: 'FEFO allocation for Synthetic tablet' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Batch B-0')).not.toBeInTheDocument();
    expect(screen.queryByText('STORE-1')).not.toBeInTheDocument();
    expect(screen.queryByText('FEFO')).not.toBeInTheDocument();
    expect(screen.getByText('Near expiry · 30 d')).toBeInTheDocument();
    expect(screen.getByText('Batch override')).toBeInTheDocument();
  });

  it('keeps controlled, prescription, high-alert, and cold-chain badges outside the truncated line', () => {
    const value = cart([inDays(400)]);
    value.lines[0] = {
      ...value.lines[0]!,
      presentation: 'A presentation long enough to be truncated beside a price',
      controlled: true,
      rx: true,
      highAlert: true,
      coldChain: true,
    };
    render(<CounterCartPanel cart={value} state="ready" onRetry={vi.fn()} now={NOW} />);
    const sale = screen.getByText(/A presentation long enough/);
    expect(sale.tagName).toBe('P');
    expect(sale.className).toContain('truncate');
    expect(sale).not.toHaveTextContent('Controlled');
    for (const label of ['Controlled', 'Prescription only', 'High alert', 'Cold chain']) {
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
