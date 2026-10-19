import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CounterSearchRow } from '@/lib/pharmacy/counter';
import type { CounterSearchResultsProps } from './counter-search-results';
import { resolveCounterKeymap } from '@/lib/pharmacy/counter-keymap';
import { saleUnitOptions, type SaleUnitKind } from '@/lib/pharmacy/counter-pricing';

const mocks = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  queryCalls: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: 'authenticated',
    data: {
      user: { id: 'account-a', organizationId: 'org-a', status: 'ACTIVE', sessionRevoked: false },
    },
  }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ organizationId: 'org-a', enabledModules: ['pharmacy-counter'] }),
}));
vi.mock('@/lib/trpc', () => {
  const router = (names: string[]) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          useQuery: (input: unknown, options: unknown) => {
            mocks.queryCalls(name, input, options);
            return {
              data: mocks.queries[name],
              isSuccess: true,
              isLoading: false,
              isFetching: false,
              isError: false,
              refetch: mocks.invalidate,
            };
          },
          useMutation: () => ({
            mutateAsync: mocks.mutations[name],
            mutate: mocks.mutations[name],
            isPending: false,
          }),
        },
      ])
    );
  const utils = {
    pharmacySales: Object.fromEntries(
      ['counterCart', 'counterReceipt', 'counterSearch', 'counterKeymap'].map((name) => [
        name,
        { cancel: mocks.invalidate, invalidate: mocks.invalidate },
      ])
    ),
  };
  return {
    trpc: {
      useUtils: () => utils,
      pharmacySales: router([
        'counterBranches',
        'counterKeymap',
        'counterSaveKeymap',
        'counterSearch',
        'counterCart',
        'counterReceipt',
        'customerSnapshot',
        'create',
        'addLine',
        'transition',
        'tender',
        'openDrawer',
        'captureDemand',
        'declineSubstitute',
        'linkCustomer',
        'redeemPoints',
        'authenticatePack',
        'substituteProposals',
      ]),
      pharmacyPrescriptions: router(['counterPatients', 'counterPatientPanel']),
    },
  };
});
vi.mock('./counter-receipt-view', () => ({ CounterReceiptView: () => null }));
vi.mock('./counter-rx-panel', () => ({ CounterRxPanel: () => null }));
vi.mock('./counter-keymap-legend', () => ({ CounterKeymapLegend: () => null }));
vi.mock('./counter-search-results', () => ({
  CounterSearchResults: ({ rows, onSelect, onCaptureDemand }: CounterSearchResultsProps) => (
    <>
      {rows.map((row) => (
        <button key={row.medicineId} onClick={() => onSelect(row)}>
          Select {row.displayName}
        </button>
      ))}
      <button onClick={onCaptureDemand}>Capture demand</button>
    </>
  ),
}));

import { PharmacyCounterConsole } from './counter-console';

const row: CounterSearchRow = {
  medicineId: 'medicine-a',
  displayName: 'Synthetic item',
  brandName: null,
  manufacturer: null,
  strength: null,
  presentationId: 'presentation-a',
  presentation: 'Pack',
  dosageForm: null,
  route: null,
  matchedOn: 'NAME',
  recommendedLotId: 'lot-a',
  packLevelId: 'box',
  unitsPerPack: 100,
  printedMrpMinor: 25000,
  roundingIncrementMinor: 1,
  batchNumber: null,
  nearestSafeExpiry: null,
  onHandUnits: 5000,
  saleableUnits: [],
  saleUnits: saleUnitOptions({
    rootPackLevelId: 'box',
    unitsPerPack: 100,
    packLevels: [
      { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
      { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 10 },
      { id: 'unit', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 },
    ],
  }),
  restriction: {
    rx: false,
    otc: true,
    restricted: false,
    controlled: false,
    highAlert: false,
    lasa: false,
  },
  storage: { coldChain: false, locationKind: null, locationCode: null },
  blocked: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.queries = {
    counterBranches: { branches: [{ id: 'branch-a', name: 'Synthetic branch' }] },
    counterKeymap: resolveCounterKeymap({ preset: 'legacySpeed' }),
    counterSearch: { rows: [row] },
    substituteProposals: [
      {
        inventoryLotId: 'substitute-lot',
        displayName: 'Synthetic substitute',
        priceMinor: 100,
        priceDifferenceMinor: 10,
      },
    ],
  };
  for (const name of [
    'counterSaveKeymap',
    'create',
    'addLine',
    'transition',
    'tender',
    'openDrawer',
    'captureDemand',
    'declineSubstitute',
    'linkCustomer',
    'redeemPoints',
    'authenticatePack',
  ]) {
    mocks.mutations[name] = vi.fn().mockResolvedValue(name === 'create' ? { id: 'sale-a' } : {});
  }
});

async function stage(kind: SaleUnitKind | null = 'PACK') {
  render(<PharmacyCounterConsole />);
  const search = screen.getByLabelText('Scan or search');
  fireEvent.change(search, { target: { value: 'Synthetic' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: 'Select Synthetic item' }));
  if (kind) fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${kind}`, 'i') }));
  const input = screen.getByLabelText(kind ? 'Quantity' : 'Requested canonical units');
  await waitFor(() => expect(input).not.toBeDisabled());
  return input;
}

function change(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function latestSubstituteQuery() {
  return mocks.queryCalls.mock.calls.filter(([name]) => name === 'substituteProposals').at(-1);
}

describe('counter quantity draft submission guards', () => {
  it.each(['PACK', 'STRIP', 'UNIT'] as const)(
    'keeps blank across blur/refocus; replacement submits exactly 12 %s',
    async (kind) => {
      const input = await stage(kind);
      expect(input).toHaveValue(1);
      change(input, '');
      fireEvent.blur(input);
      fireEvent.focus(input);
      expect(input).toHaveValue(null);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(screen.queryByText('Line total')).toBeNull();
      change(input, '12');
      expect(input).toHaveValue(12);
      expect(input).not.toHaveAttribute('aria-invalid', 'true');
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
      expect(mocks.mutations.addLine).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 12,
          saleUnit: kind,
          canonicalUnitsPerSaleUnit: kind === 'PACK' ? 100 : kind === 'STRIP' ? 10 : 1,
        })
      );
      await screen.findByText('12 × Synthetic item added.');
    }
  );

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e309', '9007199254740992'])(
    'blocks invalid draft %j in every sale unit, including keyboard and demand',
    async (draft) => {
      const input = await stage();
      for (const kind of ['Pack', 'Strip', 'Unit']) {
        fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${kind}`) }));
        change(input, '12');
        change(input, draft);
        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(screen.queryByText('Line total')).toBeNull();
        const add = screen.getByRole('button', { name: /Add to cart/ });
        expect(add).toBeDisabled();
        fireEvent.click(add);
        fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
        fireEvent.keyDown(input, { key: 'Enter' });
        fireEvent.keyDown(input, { key: 'F6', shiftKey: true });
        fireEvent.click(screen.getByRole('button', { name: 'Capture demand' }));
        expect(latestSubstituteQuery()?.[2]).toEqual({ enabled: false });
        expect(screen.queryByRole('button', { name: 'Patient declined substitutes' })).toBeNull();
      }
      for (const mutation of Object.values(mocks.mutations))
        expect(mutation).not.toHaveBeenCalled();
    }
  );

  it.each(['Pack', 'Strip'])(
    'blocks unsafe canonical multiplication in %s and restores a valid replacement',
    async (kind) => {
      const input = await stage();
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${kind}`) }));
      change(input, String(Number.MAX_SAFE_INTEGER));
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(screen.queryByText('Line total')).toBeNull();
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      fireEvent.keyDown(input, { key: 'F6', shiftKey: true });
      fireEvent.click(screen.getByRole('button', { name: 'Capture demand' }));
      expect(latestSubstituteQuery()?.[2]).toEqual({ enabled: false });
      for (const mutation of Object.values(mocks.mutations))
        expect(mutation).not.toHaveBeenCalled();
      change(input, '12');
      fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
      await screen.findByText('12 × Synthetic item added.');
      expect(mocks.mutations.addLine).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 12 })
      );
    }
  );

  it('removes existing shortfall proposals while invalid; replacement reaches demand and decline exactly', async () => {
    mocks.queries.counterSearch = { rows: [{ ...row, onHandUnits: 0 }] };
    const input = await stage('STRIP');
    expect(
      screen.getByRole('button', { name: 'Patient declined substitutes' })
    ).toBeInTheDocument();
    change(input, '');
    expect(screen.queryByRole('button', { name: 'Patient declined substitutes' })).toBeNull();
    expect(latestSubstituteQuery()?.[2]).toEqual({ enabled: false });
    fireEvent.keyDown(input, { key: 'F6', shiftKey: true });
    expect(mocks.mutations.captureDemand).not.toHaveBeenCalled();
    change(input, '12');
    expect(latestSubstituteQuery()?.[1]).toEqual(
      expect.objectContaining({ quantityCanonicalUnits: 120 })
    );
    fireEvent.keyDown(input, { key: 'F6', shiftKey: true });
    await screen.findByText(
      'Captured 120 canonical units of unfulfilled demand for Synthetic item.'
    );
    expect(mocks.mutations.captureDemand).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 120,
        saleUnit: 'UNIT',
        inventoryRuleSnapshot: expect.objectContaining({
          requestedQuantity: 12,
          requestedSaleUnit: 'STRIP',
          canonicalUnitsPerSaleUnit: 10,
        }),
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Patient declined substitutes' }));
    await screen.findByText('Demand closed: substitute declined.');
    expect(mocks.mutations.declineSubstitute).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 12, saleUnit: 'STRIP' })
    );
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    expect(mocks.mutations.create).not.toHaveBeenCalled();
  });

  it('preserves the draft when units change and resets to one on selection', async () => {
    const input = await stage();
    change(input, '');
    fireEvent.keyDown(input, { key: 'F6' });
    expect(screen.getByRole('radio', { name: /^Strip/ })).toHaveAttribute('aria-checked', 'true');
    expect(input).toHaveValue(null);
    change(input, '12');
    fireEvent.click(screen.getByRole('button', { name: 'Select Synthetic item' }));
    expect(input).toHaveValue(1);
  });
});

// searchCounterCatalog leaves every lot/pricing field null and saleUnits empty
// when no safe stock exists. Demand is still selectable in canonical UNITs.
const stockoutRow: CounterSearchRow = {
  ...row,
  recommendedLotId: null,
  packLevelId: null,
  unitsPerPack: null,
  printedMrpMinor: null,
  onHandUnits: 0,
  saleableUnits: [],
  saleUnits: [],
  storage: { ...row.storage, locationName: null },
};

describe('counter demand draft without a sale conversion', () => {
  beforeEach(() => {
    mocks.queries.counterSearch = { rows: [stockoutRow] };
  });

  it('captures the default one UNIT through Shift+F6 while Add stays blocked', async () => {
    const input = await stage(null);
    expect(input).toHaveValue(1);
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    const add = screen.getByRole('button', { name: /Add to cart/ });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'F6', shiftKey: true });
    await screen.findByText('Captured 1 canonical units of unfulfilled demand for Synthetic item.');
    expect(mocks.mutations.captureDemand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestedMedicineId: stockoutRow.medicineId,
        saleUnit: 'UNIT',
        quantity: 1,
        reason: 'STOCKOUT',
        inventoryRuleSnapshot: expect.objectContaining({
          requestedQuantity: 1,
          requestedSaleUnit: 'UNIT',
          canonicalUnitsPerSaleUnit: 1,
          requestedCanonicalUnits: 1,
          shortfallCanonicalUnits: 1,
          onHandUnits: 0,
        }),
      })
    );
    for (const [name, mutation] of Object.entries(mocks.mutations))
      if (name !== 'captureDemand') expect(mutation).not.toHaveBeenCalled();
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e309', '9007199254740992'])(
    'blocks invalid canonical draft %j without reusing the previous amount; replacement captures 12',
    async (draft) => {
      const input = await stage(null);
      change(input, '710');
      change(input, draft);
      fireEvent.blur(input);
      fireEvent.focus(input);
      if (draft === '') expect(input).toHaveValue(null);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(
        'Enter a whole number greater than zero within the safe quantity range.'
      );
      expect(screen.queryByRole('button', { name: /Capture shortfall:/ })).toBeNull();
      expect(screen.queryByText('Line total')).toBeNull();
      expect(latestSubstituteQuery()?.[2]).toEqual({ enabled: false });
      const add = screen.getByRole('button', { name: /Add to cart/ });
      expect(add).toBeDisabled();
      fireEvent.click(add);
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      fireEvent.keyDown(input, { key: 'F6', shiftKey: true });
      fireEvent.click(screen.getByRole('button', { name: 'Capture demand' }));
      for (const mutation of Object.values(mocks.mutations))
        expect(mutation).not.toHaveBeenCalled();

      change(input, '12');
      expect(input).toHaveValue(12);
      expect(input).not.toHaveAttribute('aria-invalid', 'true');
      expect(add).toBeDisabled();
      fireEvent.click(
        screen.getByRole('button', { name: 'Capture shortfall: 12 canonical units' })
      );
      await screen.findByText(
        'Captured 12 canonical units of unfulfilled demand for Synthetic item.'
      );
      expect(mocks.mutations.captureDemand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ saleUnit: 'UNIT', quantity: 12, reason: 'STOCKOUT' })
      );
      for (const [name, mutation] of Object.entries(mocks.mutations))
        if (name !== 'captureDemand') expect(mutation).not.toHaveBeenCalled();
    }
  );
});
