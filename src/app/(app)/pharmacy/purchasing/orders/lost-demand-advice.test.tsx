import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lost-demand-actions', () => ({
  draftLostDemandOrder: vi.fn(),
  requestLostDemandTransfer: vi.fn(),
  ignoreLostDemandAdvice: vi.fn(),
}));
vi.mock('../_components/action-form', () => ({
  PurchasingActionForm: ({ children }: { children: ReactNode }) => <form>{children}</form>,
}));

import {
  DEFAULT_LOST_DEMAND_TRIGGERS,
  buildLostDemandAdvice,
  evaluateLostDemandTriggers,
} from '@/lib/pharmacy/lost-demand-advice';
import { LostDemandAdvicePanel } from './lost-demand-advice';

afterEach(cleanup);

const NOW = new Date('2026-11-15T12:00:00.000Z');
const trigger = evaluateLostDemandTriggers(
  Array.from({ length: 3 }, (_, index) => ({
    id: `e${index}`,
    createdAt: new Date(NOW.getTime() - 86_400_000),
    demandKey: 'sku:med_a',
    medicineId: 'med_a',
    label: 'Brand A',
    canonicalUnits: 10,
    estimatedValueMinor: 5_000,
    walkOut: false,
  })),
  { completedSales: 50, walkOuts: 0 },
  DEFAULT_LOST_DEMAND_TRIGGERS,
  NOW
)[0]!;

const card = buildLostDemandAdvice({
  trigger,
  config: DEFAULT_LOST_DEMAND_TRIGGERS,
  medicineId: 'med_a',
  dailyDemandUnits: 10,
  onHandUnits: 5,
  onOrderUnits: 0,
  distributors: [
    {
      supplierId: 'sup_a',
      supplierName: 'Alpha Distributors',
      medicineId: 'med_a',
      packLevelId: 'pack_a',
      canonicalUnitsPerPack: 10,
      lastListPricePerPackMinor: 50_000,
      lastDiscountBps: 0,
      lastOrderedAt: NOW,
      scheme: { buyPacks: 10, bonusPacks: 1 },
      leadTimeDays: 2,
    },
  ],
  alternates: [
    { medicineId: 'alt', label: 'Brand B', availableUnits: 12, marginPerUnitMinor: 250 },
  ],
  donors: [{ branchId: 'b2', branchName: 'South', availableUnits: 500, dailyDemandUnits: 1 }],
  currency: 'PKR',
});

describe('LostDemandAdvicePanel', () => {
  it('shows the computed advice with Draft PO, Transfer request and Ignore', () => {
    render(
      <LostDemandAdvicePanel
        state={{ kind: 'ready', branchId: 'b1', branchName: 'North', advice: [card] }}
      />
    );
    expect(screen.getByText(/nothing is approved or sent/i)).toBeVisible();
    expect(screen.getByText('Repeat requests')).toBeVisible();
    const row = screen.getByRole('row', { name: /Alpha Distributors/ });
    expect(within(row).getByText('9 packs')).toBeVisible();
    expect(within(row).getByText('10 + 1 free')).toBeVisible();
    expect(within(row).getByRole('button', { name: 'Draft PO' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Request \d+ units from South/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ignore' })).toBeVisible();
    expect(screen.getByText('Brand B')).toBeVisible();
    // No control on the card approves or sends anything.
    expect(screen.queryByRole('button', { name: /approve|send/i })).toBeNull();
  });

  it('explains the empty, unavailable and unselected states', () => {
    const { rerender } = render(
      <LostDemandAdvicePanel
        state={{ kind: 'ready', branchId: 'b1', branchName: 'North', advice: [] }}
      />
    );
    expect(screen.getByText('No advice for North')).toBeVisible();
    rerender(<LostDemandAdvicePanel state={{ kind: 'unavailable' }} />);
    expect(screen.getByText(/could not be read/)).toBeVisible();
    rerender(<LostDemandAdvicePanel state={{ kind: 'unselected' }} />);
    expect(screen.getByText(/Choose a branch/)).toBeVisible();
  });
});
