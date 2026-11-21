import { useState, type ReactNode } from 'react';

import {
  PayApInvoiceForm,
  RecordApInvoiceForm,
  RequestCreditSetOffForm,
} from '@/app/(app)/pharmacy/accounts/ap-aging/ap-entry-forms';
import { CreateChannelDialog } from '@/components/chat/sidebar/create-channel-dialog';
import { HotelMealPlansPanel, type HotelMealPlansView } from '@/components/hotel/meal-plans-panel';
import { SubstitutionForm } from '@/components/pharmacy/dispensing/substitution-form';
import { ExpiryBoard } from '@/components/pharmacy/inventory/expiry-board';
import { TransferReceiveForm } from '@/components/pharmacy/inventory/transfers/transfer-receive-form';
import type { TransferBoardRow } from '@/components/pharmacy/inventory/transfers/transfer-presentation';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

/** Local fixture identities and data only; no authenticated or production source is used. */
export const extraFixtureSession = {
  user: { id: 'fixture-user', organizationId: 'fixture-org' },
};

export const extraFixtureTeam = [
  { id: 'fixture-member-1', name: 'Amina Example', title: 'Operations', avatar: null },
  { id: 'fixture-member-2', name: 'Bilal Example', title: 'Design', avatar: null },
];

export const extraFixtureMealPlans: HotelMealPlansView = {
  plans: [],
  mealOptions: [
    { value: 'BREAKFAST', label: 'Breakfast' },
    { value: 'LUNCH', label: 'Lunch' },
    { value: 'DINNER', label: 'Dinner' },
  ],
  standardCodes: ['EP', 'CP', 'MAP', 'AP'],
};

// The component consumes only the displayed receipt fields below. Its complete
// router output includes operational evidence irrelevant to this isolated view.
const transfer = {
  id: 'fixture-transfer-00000001',
  lines: [
    {
      id: 'fixture-line-1',
      medicineName: 'Example tablets 500 mg',
      batchNumber: 'BATCH-001',
      quantityUnits: 20,
      receivedUnits: 0,
    },
    {
      id: 'fixture-line-2',
      medicineName: 'Example oral solution 100 ml',
      batchNumber: 'BATCH-002',
      quantityUnits: 12,
      receivedUnits: 2,
    },
  ],
} as TransferBoardRow;

function ChatFixture() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <PageHeader eyebrow="WORKSPACE" heading="Channels" />
      <Button onClick={() => setOpen(true)}>Create a channel</Button>
      <CreateChannelDialog open={open} onOpenChange={setOpen} onCreated={() => {}} />
    </>
  );
}

export const extraScreens: Record<string, ReactNode> = {
  'pharmacy-accounts': (
    <>
      <PageHeader eyebrow="PHARMACY ACCOUNTS" heading="Bills and payments" />
      <SectionCard title="Record invoice" titleLevel={2}>
        <RecordApInvoiceForm
          branchId="fixture-branch-main"
          initialKey="fixture-invoice-command"
          today="2026-11-20"
        />
      </SectionCard>
      <SectionCard title="Pay an open bill" titleLevel={2}>
        <PayApInvoiceForm
          branchId="fixture-branch-main"
          initialKey="fixture-payment-command"
          now="2026-11-20T09:00"
          invoices={[
            {
              invoiceId: 'fixture-invoice-a',
              reference: 'AP-0001',
              payeeName: 'Example distributor',
              supplierInvoiceRef: 'INV-0001',
              currency: 'PKR',
              outstanding: '1250.00',
            },
            {
              invoiceId: 'fixture-invoice-b',
              reference: 'AP-0002',
              payeeName: 'Second example distributor',
              supplierInvoiceRef: 'INV-0002',
              currency: 'PKR',
              outstanding: '2750.00',
            },
          ]}
        />
      </SectionCard>
      <SectionCard title="Request credit note set-off" titleLevel={2}>
        <RequestCreditSetOffForm
          branchId="fixture-branch-main"
          initialKey="fixture-set-off-command"
          bills={[
            {
              invoiceId: 'fixture-invoice-a',
              reference: 'AP-0001',
              payeeName: 'Example distributor',
              supplierInvoiceRef: 'INV-0001',
              outstanding: '1250.00',
            },
            {
              invoiceId: 'fixture-invoice-b',
              reference: 'AP-0002',
              payeeName: 'Second example distributor',
              supplierInvoiceRef: 'INV-0002',
              outstanding: '2750.00',
            },
          ]}
          credits={[
            {
              creditId: 'fixture-credit-a',
              reference: 'CN-0001',
              supplierName: 'Example distributor',
              remaining: '250.00',
            },
            {
              creditId: 'fixture-credit-b',
              reference: 'CN-0002',
              supplierName: 'Second example distributor',
              remaining: '750.00',
            },
          ]}
        />
      </SectionCard>
    </>
  ),
  'pharmacy-dispensing': (
    <>
      <PageHeader eyebrow="PHARMACY DISPENSING" heading="Substitution evidence" />
      <SectionCard title="Record the supplied presentation" titleLevel={2}>
        <SubstitutionForm
          prescribed={{ id: 'fixture-original', label: 'Example prescribed tablets 500 mg' }}
          choices={[
            { id: 'fixture-supplied-a', label: 'Example supplied tablets 500 mg · pack of 20' },
            { id: 'fixture-supplied-b', label: 'Example supplied tablets 500 mg · pack of 10' },
          ]}
          onSubmit={() => {}}
        />
      </SectionCard>
    </>
  ),
  'pharmacy-transfers': (
    <>
      <PageHeader eyebrow="PHARMACY INVENTORY" heading="Receive stock transfer" />
      <SectionCard title="Receive TR-00000001" titleLevel={2}>
        <TransferReceiveForm
          transfer={transfer}
          branchId="fixture-branch-main"
          witnesses={[
            { id: 'fixture-witness-a', name: 'Amina Example', title: 'Pharmacist' },
            { id: 'fixture-witness-b', name: 'Bilal Example', title: 'Store manager' },
          ]}
          action={async () => '/pharmacy/inventory/transfers'}
        />
      </SectionCard>
    </>
  ),
  'hotel-meal-plans': (
    <>
      <PageHeader eyebrow="HOTEL SETTINGS" heading="Meal plans" />
      <HotelMealPlansPanel
        initial={extraFixtureMealPlans}
        selection={{
          userId: extraFixtureSession.user.id,
          organizationId: extraFixtureSession.user.organizationId,
          branchId: 'fixture-property',
        }}
      />
    </>
  ),
  'pharmacy-expiry': (
    <>
      <PageHeader eyebrow="PHARMACY INVENTORY" heading="Near-expiry stock" />
      <ExpiryBoard
        view="board"
        branchId="fixture-branch-main"
        branchName="Main branch"
        withinDays={90}
        generatedAt="2026-11-20T09:00:00.000Z"
        costVisible
        riskBuckets={[{ days: 90, valueAtRiskMinor: 25000 }]}
        rows={[
          {
            key: 'fixture-lot-position',
            inventoryLotId: 'fixture-lot',
            stockLocationId: 'fixture-location',
            locationName: 'Main store',
            medicineName: 'Example tablets 500 mg',
            batchNumber: 'BATCH-001',
            batchState: 'ACTIVE',
            expiresAt: '2027-01-20T00:00:00.000Z',
            daysLeft: 61,
            expired: false,
            onHandUnits: 20,
            reservedUnits: 0,
            quarantinedUnits: 0,
            unitsPerPack: 10,
            printedMrpMinor: 15000,
            valueAtRiskMinor: 25000,
            supplierName: 'Example distributor',
            suggestedSupplierId: 'fixture-supplier-a',
            markdownEligible: true,
            returnWindowOpensAt: null,
            returnDeadlineAt: null,
            markdown: null,
            returnDraft: null,
            requestKey: 'fixture-operation',
          },
        ]}
        suppliers={[
          { id: 'fixture-supplier-a', name: 'Example distributor' },
          { id: 'fixture-supplier-b', name: 'Second example distributor' },
        ]}
        boardHref="#board"
        printHref="#print"
        returnsHref="#returns"
        action={async () => {}}
      />
    </>
  ),
  'workspace-chat': <ChatFixture />,
};

/** Maps browser evidence to real product components, never a reconstructed control gallery. */
export const extraScreenSources = {
  'pharmacy-accounts': ['src/app/(app)/pharmacy/accounts/ap-aging/ap-entry-forms.tsx'],
  'pharmacy-dispensing': ['src/components/pharmacy/dispensing/substitution-form.tsx'],
  'pharmacy-transfers': ['src/components/pharmacy/inventory/transfers/transfer-receive-form.tsx'],
  'hotel-meal-plans': ['src/components/hotel/meal-plans-panel.tsx'],
  'pharmacy-expiry': ['src/components/pharmacy/inventory/expiry-board.tsx'],
  'workspace-chat': ['src/components/chat/sidebar/create-channel-dialog.tsx'],
};
