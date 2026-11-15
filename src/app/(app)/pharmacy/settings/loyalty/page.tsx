import { unstable_rethrow } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from '../../loyalty/loyalty-router';
import { LoyaltySettingsForm } from './settings-form';

async function loadSettings() {
  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    const settings = await caller.settings();
    return { ...settings, branches: await caller.branches() };
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

export default async function LoyaltySettingsPage() {
  const header = (
    <PageHeader
      eyebrow="Pharmacy / settings"
      heading="Loyalty earning"
      description="Set earning for this organization. Redemption remains PKR 1 per point."
    />
  );
  const data = await loadSettings();
  if (!data) {
    return (
      <main className="min-w-0 space-y-6">
        {header}
        <SectionCard title="Settings unavailable" titleLevel={2}>
          <p role="alert">
            An authorized owner with Pharmacy CRM access is required. If you have access, reload to
            retry.
          </p>
        </SectionCard>
      </main>
    );
  }
  const { program, migrated, reconciliation, branches } = data;
  const totals = new Map<string, { points: bigint; count: number }>();
  for (const row of reconciliation.totals) {
    const prior = totals.get(row.branchId) ?? { points: BigInt(0), count: 0 };
    totals.set(row.branchId, {
      points: prior.points + BigInt(row.points),
      count: prior.count + row.count,
    });
  }
  return (
    <main className="min-w-0 space-y-6">
      {header}
      <SectionCard title="Current program" titleLevel={2}>
        <p>
          {program
            ? `Version ${program.version}: ${program.rewardPoints} point(s) per PKR ${program.spendMinor / 100} (${program.mode === 'STEP' ? 'complete steps' : 'proportional'}). Khata earning ${program.khataEnabled ? 'on' : 'off'}.`
            : 'Earning is off until an owner selects a rate.'}
        </p>
      </SectionCard>
      <SectionCard
        title={migrated ? 'Reconciled organization wallet' : 'Review existing branch balances'}
        titleLevel={2}
      >
        <p>
          Historical entries and refunds stay linked to their original branches. These balances are
          summed once, never reset or repriced.
        </p>
        {totals.size ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="p-3 text-left">Branch</th>
                  <th className="p-3 text-right">Entries</th>
                  <th className="p-3 text-right">Points</th>
                </tr>
              </thead>
              <tbody>
                {[...totals].map(([id, row]) => (
                  <tr key={id} className="border-t border-border-subtle">
                    <td className="p-3">
                      {branches.find((branch) => branch.id === id)?.name ?? id}
                    </td>
                    <td className="p-3 text-right tabular-nums">{row.count}</td>
                    <td className="p-3 text-right tabular-nums">{row.points.toString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No historical points to migrate.</p>
        )}
      </SectionCard>
      <SectionCard title="Owner configuration" titleLevel={2}>
        <LoyaltySettingsForm
          digest={reconciliation.digest}
          migrated={migrated}
          khataEnabled={program?.khataEnabled ?? false}
        />
      </SectionCard>
    </main>
  );
}
