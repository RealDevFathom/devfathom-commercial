import { useEffect, useState, type ReactNode } from 'react';

import {
  LedgerReportsSection,
  TrueProfitSection,
} from '@/app/(app)/pharmacy/finance/ledger-reports';
import { AdjustPointsForm } from '@/app/(app)/pharmacy/loyalty/adjust-points-form';
import { PrepaidPaymentForm } from '@/app/(app)/pharmacy/loyalty/prepaid/forms';
import { VoucherPanel } from '@/app/(app)/pharmacy/marketing/voucher-panel';
import { PackPhotoReader } from '@/app/(app)/pharmacy/purchasing/_components/pack-photo-reader';
import { ScenarioConsole } from '@/app/(app)/pharmacy/reports/replenishment/scenario-console';
import { MedicinePackSetup } from '@/components/pharmacy/medicine-pack-setup';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import type { PackLabelProposal } from '@/lib/pharmacy/pack-label-ocr';

const branches = [
  { id: 'fixture-branch-main', name: 'Garden pharmacy' },
  { id: 'fixture-branch-second', name: 'Riverside pharmacy' },
];

/** Fake data, supplied directly to the isolated client query adapter. */
export const pharmacyQueryData: Record<string, unknown> = {
  'pharmacyMedicine.search': [
    {
      id: 'fixture-medicine',
      productName: 'Example tablets',
      brandName: 'Example brand',
      manufacturer: 'Example manufacturer',
      strengths: [{ value: '500', unit: 'mg' }],
    },
  ],
  'pharmacyMedicine.get': {
    presentations: [
      {
        id: 'fixture-presentation',
        dosageForm: 'Tablet',
        presentation: '10 tablets',
        packLevels: [],
      },
    ],
  },
  'pharmacyReports.seasonalCalendar': { canEdit: true, windows: [] },
  'pharmacyReports.saltSpikes': { salts: [] },
};

const packProposal: PackLabelProposal = {
  status: 'PROPOSED',
  requiresReceiverConfirmation: true,
  adapter: 'FIXTURE',
  adapterVersion: 'dev-1001-local',
  batch: { value: 'BATCH-001', confidence: 0.98 },
  expiry: {
    kind: 'read',
    printed: 'EXP 06/2027',
    candidate: { date: '2027-06-30', precision: 'MONTH' },
    confidence: 0.97,
  },
  price: { kind: 'read', printed: 'MRP Rs. 450.00', amountMinor: 45000, confidence: 0.96 },
  currentMrpMinor: 45000,
  serialPrinted: false,
  warnings: [],
};

export const pharmacyMutationData: Record<string, unknown> = {
  'pharmacyPackLabel.read': packProposal,
};

const reportMeta = {
  scope: { organizationId: 'fixture-org', branchId: branches[0].id },
  timezone: 'UTC',
  moneyUnit: 'integer_minor',
  currency: 'PKR',
  currencyStatus: 'organization_setting',
  definition: 'Posted ledger entries for this local fixture.',
  source: 'finance_journal_lines',
  coverage: {
    basis: 'posted_entries_only',
    completeness: 'unknown',
    costCoverage: 'unknown',
    refunds: 'included_only_when_posted_as_reversals',
    emptyRows: 'no_matching_postings_not_proof_of_zero_activity',
  },
  freshness: { retrievedAt: new Date('2026-11-20T09:00:00Z'), latestPostingAt: null },
  labels: { branches: {}, lots: {}, batches: {}, medicines: {}, locations: {} },
  rows: [],
};
const period = {
  from: new Date('2026-11-01T00:00:00Z'),
  to: new Date('2026-11-20T00:00:00Z'),
  bounds: '[from,to)',
};
const ledgerCaller = {
  perpetualValuation: async () => ({
    ...reportMeta,
    period: { at: period.to, bounds: 'through_inclusive' },
    unallocatedValueMinor: BigInt(0),
  }),
  grossMargin: async () => ({ ...reportMeta, period, by: 'batch' }),
  leakageReport: async () => ({ ...reportMeta, period }),
} as unknown as Parameters<typeof LedgerReportsSection>[0]['caller'];
const profitCaller = {
  trueProfit: async () => ({ ...reportMeta, period, by: 'item' }),
} as unknown as Parameters<typeof TrueProfitSection>[0]['caller'];

/** Resolve the actual server presentation functions with an in-memory caller only. */
function LedgerFixture() {
  const [content, setContent] = useState<ReactNode>(null);
  useEffect(() => {
    let mounted = true;
    void Promise.all([
      LedgerReportsSection({
        caller: ledgerCaller,
        branch: branches[0],
        from: '2026-11-01',
        to: '2026-11-20',
        at: '2026-11-20',
        timeZone: 'UTC',
      }),
      TrueProfitSection({
        caller: profitCaller,
        branch: branches[0],
        from: '2026-11-01',
        to: '2026-11-20',
        timeZone: 'UTC',
      }),
    ]).then(([ledger, profit]) => {
      if (mounted)
        setContent(
          <>
            {ledger}
            {profit}
          </>
        );
    });
    return () => {
      mounted = false;
    };
  }, []);
  return (
    <>
      <PageHeader eyebrow="PHARMACY FINANCE" heading="Ledger reports" />
      {content}
    </>
  );
}

export const pharmacyScreens: Record<string, ReactNode> = {
  'pharmacy-finance': <LedgerFixture />,
  'pharmacy-loyalty': (
    <>
      <PageHeader eyebrow="PHARMACY LOYALTY" heading="Points and prepaid payments" />
      <SectionCard title="Adjust points" titleLevel={2}>
        <AdjustPointsForm branchId={branches[0].id} customerId="fixture-customer-a" />
      </SectionCard>
      <SectionCard title="Record prepaid payment" titleLevel={2}>
        <PrepaidPaymentForm
          customers={[
            { id: 'fixture-customer-a', displayName: 'Amina Example', pinSet: true },
            { id: 'fixture-customer-b', displayName: 'Bilal Example', pinSet: false },
          ]}
          branches={branches}
          drawers={[
            { branchId: branches[0].id, deviceId: 'fixture-drawer-a', label: 'Garden till' },
            { branchId: branches[1].id, deviceId: 'fixture-drawer-b', label: 'Riverside till' },
          ]}
          paymentReference="fixture-prepaid-command"
        />
      </SectionCard>
    </>
  ),
  'pharmacy-marketing': (
    <>
      <PageHeader eyebrow="PHARMACY MARKETING" heading="Vouchers" />
      <VoucherPanel
        branchId={branches[0].id}
        vouchers={[]}
        unavailable={false}
        timeZone="UTC"
        approvers={[
          { id: 'fixture-user', name: 'Fixture Owner', self: true },
          { id: 'fixture-manager', name: 'Example Manager', self: false },
        ]}
      />
    </>
  ),
  'pharmacy-reports': (
    <>
      <PageHeader eyebrow="PHARMACY REPORTS" heading="Replenishment planning" />
      <ScenarioConsole
        organizationId="fixture-org"
        branches={branches}
        financial
        initialBranchId={branches[0].id}
        invalidInitialBranch={false}
        today="2026-11-20"
        timeZone="UTC"
      />
    </>
  ),
  'pharmacy-pack-setup': (
    <>
      <PageHeader eyebrow="PHARMACY INVENTORY" heading="Medicine packs" />
      <MedicinePackSetup />
    </>
  ),
  'pharmacy-purchasing': (
    <>
      <PageHeader eyebrow="PHARMACY PURCHASING" heading="Receive a purchase order" />
      <SectionCard title="Review pack details" titleLevel={2}>
        <PackPhotoReader
          branchId={branches[0].id}
          purchaseOrderId="fixture-purchase-order"
          purchaseOrderLineId="fixture-order-line"
          fieldKey="fixture-capture"
          lotLabel="Example tablets lot 1"
          medicineName="Example tablets 500 mg"
          packLevel="Box"
          unitsPerPack={10}
          outstandingPacks={20}
          locations={[
            { id: 'fixture-shelf-main', label: 'Main shelf' },
            { id: 'fixture-shelf-back', label: 'Back room' },
          ]}
          defaultLocationId="fixture-shelf-main"
        />
      </SectionCard>
    </>
  ),
};

export const pharmacyScreenSources: Record<string, string[]> = {
  'pharmacy-finance': ['src/app/(app)/pharmacy/finance/ledger-reports.tsx'],
  'pharmacy-loyalty': [
    'src/app/(app)/pharmacy/loyalty/adjust-points-form.tsx',
    'src/app/(app)/pharmacy/loyalty/prepaid/forms.tsx',
  ],
  'pharmacy-marketing': ['src/app/(app)/pharmacy/marketing/voucher-panel.tsx'],
  'pharmacy-reports': [
    'src/app/(app)/pharmacy/reports/replenishment/scenario-console.tsx',
    'src/app/(app)/pharmacy/reports/replenishment/seasonal-calendar-panel.tsx',
  ],
  'pharmacy-pack-setup': ['src/components/pharmacy/medicine-pack-setup.tsx'],
  'pharmacy-purchasing': ['src/app/(app)/pharmacy/purchasing/_components/pack-photo-reader.tsx'],
};
