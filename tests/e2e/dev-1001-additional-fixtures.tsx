import type { ReactNode } from 'react';

import { PharmacyDashboardContent } from '@/app/(app)/dashboard/pharmacy-dashboard-content';
import { RestaurantManagementOverview } from '@/app/(app)/dashboard/restaurant-management-overview';
import { PortalHome, type PortalHomeData } from '@/app/(public)/my-pharmacy/portal-home';
import { EntitlementsProvider } from '@/components/entitlements-provider';
import { PharmacyCameraWizard } from '@/components/pharmacy/cameras/pharmacy-camera-wizard';
import { CustomerPortalPanel } from '@/components/pharmacy/customer-portal-panel';
import { MedicineReferenceWorkbench } from '@/components/pharmacy/medicine-reference-workbench';
import { RefillProgramConsole } from '@/components/pharmacy/refill-program-console';
import { SopSetupView } from '@/components/pharmacy/sop/sop-setup';
import { PageHeader } from '@/components/ui/page-header';
import { pharmacyDashboardDefault } from '@/lib/pharmacy/dashboard';

const branches = [
  { id: 'fixture-pharmacy-main', name: 'Main example branch' },
  { id: 'fixture-pharmacy-river', name: 'Riverside example branch' },
];

/** Isolated query responses for real screens. All names and records are synthetic. */
export const additionalQueryData: Record<string, unknown> = {
  'pharmacyOrdering.branches': { branches, currency: 'PKR' },
  'pharmacyOrdering.refillProgram': [],
  'pharmacyOrdering.customers': [
    { id: 'fixture-customer-a', displayName: 'Amina Example', phoneLast4: '0101' },
    { id: 'fixture-customer-b', displayName: 'Bilal Example', phoneLast4: '0202' },
  ],
  'pharmacyOrdering.subscriptionCatalog': [
    {
      medicineId: 'fixture-medicine-a',
      productName: 'Example monthly tablets 500 mg',
      prescriptionOnly: true,
      presentationId: 'fixture-presentation-a',
      presentation: 'Tablet',
      packLevelId: 'fixture-pack-a',
      packLabel: 'Box of 30',
    },
    {
      medicineId: 'fixture-medicine-b',
      productName: 'Example vitamin tablets',
      prescriptionOnly: false,
      presentationId: 'fixture-presentation-b',
      presentation: 'Tablet',
      packLevelId: 'fixture-pack-b',
      packLabel: 'Bottle of 30',
    },
  ],
  'pharmacyOrdering.portalQueue': {
    requests: [],
    canVerifyPrescriptions: true,
    canConfirmPayments: true,
  },
  'pharmacyReports.branches': { branches },
  'pharmacyReports.catalog': {
    permissions: { owner: true, operational: true, financial: true },
    metrics: [],
  },
  'pharmacyReports.getPreferences': pharmacyDashboardDefault('ADMIN'),
  'pharmacyReports.commandCentre': {
    freshness: { asOf: '2026-11-20T09:00:00.000Z', source: 'Isolated example records' },
    permissions: { operational: true, financial: true },
    metrics: {},
  },
  'restaurantDashboard.getPreferences': {
    version: 1,
    defaultBranchId: null,
    rangeDays: 7,
    widgets: [
      { key: 'performance', visible: true, span: 'wide' },
      { key: 'trend', visible: true, span: 'wide' },
      { key: 'exceptions', visible: true, span: 'compact' },
      { key: 'itemMix', visible: true, span: 'compact' },
      { key: 'labour', visible: true, span: 'wide' },
    ],
  },
  'restaurantInsights.listFinancialReports': [],
  'restaurantInsights.listOperationalReports': [],
  'restaurantInsights.listLabourCosts': [],
  'pharmacySop.roleHoldings': [],
  'pharmacySop.assignments': [],
  'pharmacySop.siteSettings': {
    pharmacyBranchId: branches[0]!.id,
    autoScheduleEnabled: false,
    changedAt: null,
    reason: null,
  },
  'pharmacySop.overdueEscalation': { enabled: false, delayMinutes: 30 },
  'pharmacySop.templates': [
    {
      id: 'fixture-opening-template',
      name: 'Pharmacy — opening',
      category: 'Opening',
      isActive: true,
      publishedVersion: { id: 'fixture-opening-version', versionNumber: 1 },
      steps: [],
      pack: {
        key: 'opening',
        name: 'Pharmacy — opening',
        category: 'Opening',
        description: 'Review opening procedures for this example branch.',
        roleKey: 'pharmacy-qualified-person',
        assigneeTarget: 'ROLE',
        verifierRoleKeys: ['pharmacy-manager'],
        trigger: 'SHIFT',
        suggestedRecurrence: {
          frequency: 'DAILY',
          interval: 1,
          daysOfWeek: [],
          monthDay: null,
          dueTimeMinutes: null,
          intervalEndTimeMinutes: null,
          windowMinutes: 120,
          graceMinutes: 30,
        },
      },
    },
  ],
  'pharmacyMedicine.referenceCandidates': [],
  'pharmacyMedicine.referenceConnectorProposals': [],
};

/** No mutation is required to expose these controls. */
export const additionalMutationData: Record<string, unknown> = {};

const portalHome: PortalHomeData = {
  customer: { displayName: 'Amina Example' },
  branchName: branches[0]!.name,
  currency: 'PKR',
  loyaltyPoints: 120,
  receipts: [],
  khataAccounts: [
    { id: 'fixture-khata-a', displayName: 'Household account', balanceMinor: 120000 },
    { id: 'fixture-khata-b', displayName: 'Personal account', balanceMinor: 45000 },
  ],
  raast: { destination: 'Isolated example payment destination', qrImageDataUrl: null },
  offers: [],
  requests: [],
};

/** Read-only local fetch responses; no portal payment or request is submitted. */
export const additionalFetchResponses: Record<string, unknown> = {
  '/api/pharmacy/portal/me': { ok: true, home: portalHome },
};

export const additionalScreens: Record<string, ReactNode> = {
  'pharmacy-dashboard': (
    <EntitlementsProvider
      value={{
        organizationId: 'fixture-pharmacy-org',
        vertical: 'PHARMACY',
        modules: [],
        enabledModules: ['pharmacy-reports', 'pharmacy-crm'],
        limits: {},
        seatLimit: 100,
        activeSeats: 2,
      }}
    >
      <PharmacyDashboardContent role="ADMIN" reportAccess />
    </EntitlementsProvider>
  ),
  'restaurant-dashboard': <RestaurantManagementOverview insightsEnabled />,
  'pharmacy-public-portal': <PortalHome />,
  'pharmacy-customer-portal': (
    <>
      <PageHeader eyebrow="PHARMACY CUSTOMERS" heading="Customer app" />
      <CustomerPortalPanel />
    </>
  ),
  'pharmacy-cameras': (
    <>
      <PageHeader eyebrow="PHARMACY CAMERAS" heading="Camera setup" />
      <PharmacyCameraWizard
        branches={branches}
        gateways={branches.map((branch, index) => ({
          id: `fixture-gateway-${index}`,
          name: `Example gateway ${index + 1}`,
          branchId: branch.id,
          status: 'ONLINE',
        }))}
        onTest={async () => ({ outcome: 'unreachable' })}
        onSubmit={async () => {}}
      />
    </>
  ),
  'pharmacy-refills': (
    <>
      <PageHeader eyebrow="PHARMACY CUSTOMERS" heading="Refill program" />
      <RefillProgramConsole />
    </>
  ),
  'pharmacy-procedures': (
    <>
      <PageHeader eyebrow="PHARMACY PROCEDURES" heading="Procedure setup" />
      <SopSetupView
        branch={{
          pharmacyBranchId: branches[0]!.id,
          name: branches[0]!.name,
          sopBranchId: 'fixture-sop-main',
          timezone: 'Asia/Karachi',
        }}
        defaultTimezone="Asia/Karachi"
        onChanged={() => {}}
        onNotice={() => {}}
      />
    </>
  ),
  'pharmacy-reference-import': (
    <>
      <PageHeader eyebrow="PHARMACY CATALOGUE" heading="Medicine reference workbench" />
      <MedicineReferenceWorkbench
        health={[
          {
            id: 'manual-file',
            label: 'Manual reference file',
            enabled: true,
            status: 'READY',
            detail: 'Isolated CSV fixture; no reference source is contacted.',
          },
        ]}
      />
    </>
  ),
};

export const additionalScreenSources = {
  'pharmacy-dashboard': ['src/app/(app)/dashboard/pharmacy-dashboard-content.tsx'],
  'restaurant-dashboard': ['src/app/(app)/dashboard/restaurant-management-overview.tsx'],
  'pharmacy-public-portal': ['src/app/(public)/my-pharmacy/portal-home.tsx'],
  'pharmacy-customer-portal': ['src/components/pharmacy/customer-portal-panel.tsx'],
  'pharmacy-cameras': ['src/components/pharmacy/cameras/pharmacy-camera-wizard.tsx'],
  'pharmacy-refills': ['src/components/pharmacy/refill-program-console.tsx'],
  'pharmacy-procedures': ['src/components/pharmacy/sop/sop-setup.tsx'],
  'pharmacy-reference-import': ['src/components/pharmacy/medicine-reference-workbench.tsx'],
};

/** Runner preparation uses real UI actions, never reconstructed control markup. */
export const additionalScreenPreparation = {
  'pharmacy-procedures': { button: 'Create schedule for Pharmacy — opening' },
  'pharmacy-reference-import': {
    fileLabel: 'CSV or Excel workbook',
    fileName: 'example-medicine-reference.csv',
    fileType: 'text/csv',
    fileContents:
      'Product name,Brand name,Strength,Dosage form,Manufacturer\nExample tablets,Example brand,500 mg,Tablet,Example manufacturer\n',
  },
};
