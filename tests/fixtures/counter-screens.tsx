// DEV-977 visual QA harness: the real AppShell and pharmacy counter, synthetic data only.
// Built and photographed by scripts/capture-counter-screens.mjs; nothing here is a route.
import { createRoot } from 'react-dom/client';

import { AppShell } from '@/components/layout/app-shell';
import { PharmacyCounterConsole } from '@/components/pharmacy/counter/counter-console';
import { PreferencesProvider } from '@/components/preferences-provider';
import { ThemeProvider } from '@/components/theme-provider';
import type { CounterCart, CounterSearchRow } from '@/lib/pharmacy/counter';

type Line = CounterCart['lines'][number];

const line = (over: Partial<Line> & Pick<Line, 'saleLineId' | 'medicineName'>): Line => ({
  medicineId: `${over.saleLineId}-medicine`,
  strength: null,
  presentation: 'Tablet',
  dosageForm: 'Tablet',
  saleUnit: 'STRIP',
  quantity: 1,
  canonicalUnits: 10,
  unitPriceMinor: 500,
  proRataCeilingMinor: 500,
  discountMinor: 0,
  lineTotalMinor: 5000,
  rx: false,
  controlled: false,
  restricted: false,
  highAlert: false,
  lasa: false,
  coldChain: false,
  emergencySupply: false,
  allocations: [
    {
      inventoryLotId: `${over.saleLineId}-lot`,
      batchNumber: 'SYN-2408',
      expiresAt: '2028-08-31T00:00:00.000Z',
      canonicalUnits: over.canonicalUnits ?? 10,
      stockLocationCode: 'A2',
      overridden: false,
    },
  ],
  ...over,
});

const saleLines: Line[] = [
  line({
    saleLineId: 'l1',
    medicineName: 'Paracetamol',
    strength: '500 mg',
    quantity: 2,
    canonicalUnits: 20,
    unitPriceMinor: 345,
    lineTotalMinor: 6900,
  }),
  line({
    saleLineId: 'l2',
    medicineName: 'Amoxicillin and clavulanic acid',
    strength: '625 mg',
    saleUnit: 'PACK',
    canonicalUnits: 6,
    unitPriceMinor: 8667,
    lineTotalMinor: 52000,
    allocations: [
      {
        inventoryLotId: 'l2-lot',
        batchNumber: 'SYN-5521',
        expiresAt: '2027-05-31T00:00:00.000Z',
        canonicalUnits: 6,
        stockLocationCode: 'C1',
        overridden: false,
      },
    ],
  }),
  line({
    saleLineId: 'l3',
    medicineName: 'Omeprazole',
    strength: '20 mg',
    presentation: 'Capsule',
    dosageForm: 'Capsule',
    canonicalUnits: 7,
    unitPriceMinor: 3000,
    lineTotalMinor: 21000,
  }),
  line({
    saleLineId: 'l4',
    medicineName: 'Paracetamol oral suspension',
    strength: '120 mg/5 ml',
    presentation: 'Bottle 60 ml',
    dosageForm: 'Suspension',
    saleUnit: 'UNIT',
    canonicalUnits: 1,
    unitPriceMinor: 9500,
    lineTotalMinor: 9500,
  }),
];
const total = saleLines.reduce((sum, entry) => sum + entry.lineTotalMinor, 0);
const saleCart: CounterCart = {
  saleId: 'synthetic-sale',
  status: 'OPEN',
  receiptNumber: null,
  lines: saleLines,
  totals: { grossMinor: total, discountMinor: 0, netMinor: total, tenderedMinor: 0 },
};
const blockedLines: Line[] = [
  saleLines[0]!,
  saleLines[1]!,
  line({
    saleLineId: 'l5',
    medicineName: 'Alprazolam',
    strength: '0.5 mg',
    canonicalUnits: 10,
    unitPriceMinor: 1550,
    lineTotalMinor: 15500,
    controlled: true,
    rx: true,
  }),
  saleLines[2]!,
];
const blockedTotal = blockedLines.reduce((sum, entry) => sum + entry.lineTotalMinor, 0);

const row = (
  over: Partial<CounterSearchRow> & Pick<CounterSearchRow, 'medicineId' | 'displayName'>
): CounterSearchRow => ({
  brandName: null,
  manufacturer: null,
  strength: '500 mg',
  presentationId: `${over.medicineId}-presentation`,
  presentation: 'Capsule',
  dosageForm: 'Capsule',
  route: 'Oral',
  matchedOn: 'NAME',
  recommendedLotId: `${over.medicineId}-lot`,
  packLevelId: `${over.medicineId}-pack`,
  unitsPerPack: 20,
  printedMrpMinor: 30000,
  roundingIncrementMinor: 1,
  batchNumber: 'SYN-1180',
  nearestSafeExpiry: '2027-09-30T00:00:00.000Z',
  onHandUnits: 180,
  saleableUnits: [
    {
      kind: 'STRIP',
      levelLabel: 'STRIP',
      canonicalUnitsPerSaleUnit: 10,
      wholeUnits: 18,
      unitPriceMinor: 1500,
      proRataCeilingMinor: 1500,
    },
  ],
  saleUnits: [
    {
      kind: 'PACK',
      packLevelId: `${over.medicineId}-pack`,
      levelLabel: 'PACK',
      canonicalUnitsPerSaleUnit: 20,
    },
    {
      kind: 'STRIP',
      packLevelId: `${over.medicineId}-strip`,
      levelLabel: 'STRIP',
      canonicalUnitsPerSaleUnit: 10,
    },
    {
      kind: 'UNIT',
      packLevelId: `${over.medicineId}-unit`,
      levelLabel: 'UNIT',
      canonicalUnitsPerSaleUnit: 1,
    },
  ],
  restriction: {
    rx: true,
    otc: false,
    restricted: false,
    controlled: false,
    highAlert: false,
    lasa: false,
  },
  storage: {
    coldChain: false,
    locationKind: 'RACK_BIN',
    locationCode: 'C2',
    locationName: 'Rack C2',
  },
  blocked: [],
  ...over,
});

const searchRows: CounterSearchRow[] = [
  row({ medicineId: 'r1', displayName: 'Amoxicillin', strength: '500 mg' }),
  row({ medicineId: 'r2', displayName: 'Amoxicillin', strength: '250 mg', printedMrpMinor: 18000 }),
  row({
    medicineId: 'r3',
    displayName: 'Amoxicillin oral suspension',
    strength: '250 mg/5 ml',
    presentation: 'Bottle 90 ml',
    dosageForm: 'Suspension',
    unitsPerPack: 1,
    printedMrpMinor: 21000,
    onHandUnits: 9,
    saleUnits: [
      { kind: 'UNIT', packLevelId: 'r3-unit', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
    ],
  }),
  row({
    medicineId: 'r4',
    displayName: 'Amoxicillin and clavulanic acid',
    strength: '625 mg',
    presentation: 'Tablet',
    dosageForm: 'Tablet',
    unitsPerPack: 6,
    printedMrpMinor: 52000,
  }),
  row({
    medicineId: 'r5',
    displayName: 'Amoxicillin and clavulanic acid',
    strength: '1 g',
    presentation: 'Tablet',
    dosageForm: 'Tablet',
    unitsPerPack: 6,
    printedMrpMinor: 68000,
  }),
  row({
    medicineId: 'r6',
    displayName: 'Amoxicillin',
    strength: '125 mg/5 ml',
    presentation: 'Bottle 60 ml',
    dosageForm: 'Suspension',
    unitsPerPack: 1,
    printedMrpMinor: 15000,
    onHandUnits: 0,
    recommendedLotId: null,
    batchNumber: null,
    nearestSafeExpiry: null,
    saleableUnits: [],
    saleUnits: [],
  }),
  row({ medicineId: 'r7', displayName: 'Amoxicillin', strength: '1 g', printedMrpMinor: 42000 }),
];

const base: Record<string, unknown> = {
  counterBranches: {
    branches: [{ id: 'synthetic-branch', name: 'Main Street branch', code: 'SYN' }],
  },
  settlementAccess: { authorized: true, userId: 'synthetic-user', organizationId: 'synthetic-org' },
  drawerStatus: { openDrawer: { id: 'synthetic-drawer' } },
  counterCart: saleCart,
  upsellSuggestions: [],
  openBills: [],
  substituteProposals: [],
  counterLotOptions: [],
  drawerCashiers: [],
  counterPatients: [],
};

type ScenarioName = 'sale' | 'empty' | 'search' | 'staged' | 'error' | 'loading' | 'blocked';
const scenarios: Record<
  ScenarioName,
  { sale: boolean; data?: Record<string, unknown> } & Partial<Window['__counterScenario']>
> = {
  sale: { sale: true },
  empty: { sale: false },
  search: { sale: true, search: 'rows', rows: searchRows },
  staged: { sale: true, search: 'rows', rows: searchRows },
  error: { sale: true, search: 'error' },
  loading: { sale: true, loading: ['counterBranches'] },
  blocked: {
    sale: true,
    data: {
      counterCart: {
        ...saleCart,
        lines: blockedLines,
        totals: {
          grossMinor: blockedTotal,
          discountMinor: 0,
          netMinor: blockedTotal,
          tenderedMinor: 0,
        },
      },
    },
  },
};

const name = (new URLSearchParams(location.search).get('scenario') ?? 'sale') as ScenarioName;
const chosen = scenarios[name] ?? scenarios.sale;
window.__counterScenario = {
  name,
  data: { ...base, ...(chosen.data ?? {}) },
  search: chosen.search,
  rows: chosen.rows,
  loading: chosen.loading,
};
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
if (document.documentElement.dataset.theme === 'dark')
  document.documentElement.classList.add('dark');

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <PreferencesProvider>
      <AppShell
        brand={{
          organizationId: 'synthetic-org',
          displayName: 'Synthetic Pharmacy',
          logoUrl: null,
          markUrl: null,
          faviconUrl: null,
          primaryColor: null,
          accentColor: null,
        }}
      >
        <div className="pharmacy-workspace contents">
          <PharmacyCounterConsole
            initialSaleId={chosen.sale ? 'synthetic-sale' : undefined}
            initialBranchId="synthetic-branch"
          />
        </div>
      </AppShell>
    </PreferencesProvider>
  </ThemeProvider>
);
