import { useEffect, useState, type ReactNode } from 'react';

import KhataPage from '@/app/(app)/pharmacy/khata/page';
import { BranchAssignmentsPanel } from '@/components/pharmacy/branch-assignments';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

const branches = [
  { id: 'fixture-pharmacy-garden', code: 'GDN', name: 'Garden pharmacy' },
  { id: 'fixture-pharmacy-riverside', code: 'RIV', name: 'Riverside pharmacy' },
];
const members = [
  {
    id: 'fixture-pharmacist',
    name: 'Example pharmacist',
    email: 'pharmacist@example.test',
    roleName: 'Pharmacist',
  },
  {
    id: 'fixture-assistant',
    name: 'Example assistant',
    email: 'assistant@example.test',
    roleName: 'Assistant',
  },
];

/** Imports made by the real Khata server page are redirected to these local fixtures. */
export const khataFixtureContext = async () => ({ organization: { timezone: 'Asia/Karachi' } });
export const khataFixtureRouter = {
  createCaller: () => ({
    branches: async () => branches,
    ledger: async () => ({
      truncated: false,
      accounts: [
        {
          id: 'fixture-household',
          displayName: 'Example household',
          payerName: 'Example payer',
          phoneLast4: '0123',
          balanceMinor: 125000,
          creditLimitMinor: 250000,
          lastPaymentAt: new Date('2026-11-15T09:00:00Z'),
          oldestOverdueAt: new Date('2026-11-01T09:00:00Z'),
        },
        {
          id: 'fixture-cleared-household',
          displayName: 'Clear example household',
          payerName: 'Second example payer',
          phoneLast4: null,
          balanceMinor: 0,
          creditLimitMinor: 100000,
          lastPaymentAt: null,
          oldestOverdueAt: null,
        },
      ],
    }),
    sendReminder: async () => {
      throw new Error('Fixture cannot send a reminder.');
    },
  }),
};

function KhataFixture() {
  const [page, setPage] = useState<ReactNode>(null);
  useEffect(() => {
    let active = true;
    void KhataPage({ searchParams: Promise.resolve({}) }).then((result) => {
      if (active) setPage(result);
    });
    return () => {
      active = false;
    };
  }, []);
  return page;
}

function BranchAssignmentsFixture() {
  return (
    <>
      <PageHeader eyebrow="Pharmacy administration" heading="Branch assignments" />
      <SectionCard title="Assign pharmacy members">
        <BranchAssignmentsPanel
          branches={branches}
          members={members}
          assignments={[
            {
              id: 'fixture-assignment',
              branchId: branches[0]!.id,
              userId: members[0]!.id,
              branchName: branches[0]!.name,
              userName: members[0]!.name,
            },
          ]}
          pending={false}
          notice={null}
          onAssign={() => {}}
          onUnassign={() => {}}
        />
      </SectionCard>
    </>
  );
}

export const gapFinanceScreens: Record<string, ReactNode> = {
  'pharmacy-khata': <KhataFixture />,
  'pharmacy-branch-assignments': <BranchAssignmentsFixture />,
};
export const gapFinanceSources = {
  'pharmacy-khata': ['src/app/(app)/pharmacy/khata/page.tsx'],
  'pharmacy-branch-assignments': ['src/components/pharmacy/branch-assignments.tsx'],
};
