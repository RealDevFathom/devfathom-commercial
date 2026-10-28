import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import {
  compareRecordedTaxProfiles,
  recordedTaxProfileReviewCsv,
  type TaxProfileReviewDto,
} from '@/lib/pharmacy/accounts/tax-profile-review';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export const metadata: Metadata = { title: 'Tax profile review' };

const selectClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default async function TaxProfileReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; before?: string; after?: string }>;
}) {
  const query = await searchParams;
  const actor = await resolveTenantActor();
  if (!actor?.session?.user || actor.session.user.role !== 'ADMIN') return <Denied />;
  const ctx = await createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  if (
    !hasModule(ctx.entitlements, 'pharmacy-finance') ||
    !hasModule(ctx.entitlements, 'pharmacy-reports')
  )
    return <Denied />;
  for (const permission of ['reports:operational', 'reports:financial'] as const) {
    if (
      !(await can(subjectFromSession(ctx.session!.user), permission, undefined, {
        db: ctx.db,
        source: 'TRPC',
        ip: ctx.requestMeta.ip,
      }))
    )
      return <Denied />;
  }
  const organizationId = ctx.entitlements.organizationId;
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const branch = branches.find(({ id }) => id === query.branch) ?? branches[0];
  if (!branch)
    return (
      <Shell>
        <SectionCard title="No active branch">
          Create a branch before reviewing recorded tax configuration.
        </SectionCard>
      </Shell>
    );

  let profiles: TaxProfileReviewDto[] = [];
  let loadFailed = false;
  try {
    const workspace = await pharmacyFinanceRouter
      .createCaller(ctx)
      .workspace({ branchId: branch.id });
    profiles = workspace.taxProfiles as unknown as TaxProfileReviewDto[];
  } catch {
    loadFailed = true;
  }
  const approved = profiles.filter(
    (profile) => profile.status === 'PUBLISHED' && profile.approvalReference && profile.approvedAt
  );
  let review: ReturnType<typeof compareRecordedTaxProfiles> | null = null;
  let reviewError = '';
  if (query.before || query.after) {
    try {
      review = compareRecordedTaxProfiles({
        organizationId,
        branchId: branch.id,
        selectedVersionIds: [query.before ?? '', query.after ?? ''],
        profiles: approved,
      });
    } catch {
      reviewError =
        'The selected approved versions could not be compared. Export remains disabled.';
    }
  }

  return (
    <Shell>
      <SectionCard title="Compare recorded versions" eyebrow="PHARM-ACCOUNTS-TAX-PROFILE-REVIEW">
        <p className="mb-5 text-sm text-text-muted">
          Recorded configuration evidence only. This does not validate statutory returns or rates,
          sale eligibility, or compliance.
        </p>
        {loadFailed ? (
          <p className="text-sm text-destructive">
            Tax profile evidence could not load. Export is disabled and no data was changed.
          </p>
        ) : (
          <form
            method="get"
            action="/pharmacy/accounts/tax-profile-review"
            className="grid gap-3 sm:grid-cols-3"
          >
            <label className="text-sm">
              Branch
              <select className={selectClass} name="branch" defaultValue={branch.id}>
                {branches.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <VersionSelect
              name="before"
              label="Earlier approved version"
              profiles={approved}
              selected={query.before}
            />
            <VersionSelect
              name="after"
              label="Later approved version"
              profiles={approved}
              selected={query.after}
            />
            <Button type="submit" className="sm:col-span-3">
              Compare recorded evidence
            </Button>
          </form>
        )}
        {reviewError ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {reviewError}
          </p>
        ) : null}
      </SectionCard>
      {review ? (
        <SectionCard
          title={`Version ${review.before.versionNumber} to ${review.after.versionNumber}`}
          eyebrow="Recorded differences"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="font-mono text-xs uppercase text-text-muted">
                <tr>
                  <th className="p-2">Change</th>
                  <th className="p-2">Class / PCT-HS</th>
                  <th className="p-2">Before rate</th>
                  <th className="p-2">After rate</th>
                  <th className="p-2">Exemption evidence</th>
                </tr>
              </thead>
              <tbody>
                {review.changes.map((change) => (
                  <tr className="border-t border-border-subtle" key={change.key}>
                    <td className="p-2">{change.kind}</td>
                    <td className="p-2">
                      {change.before?.productClass ?? change.after?.productClass} /{' '}
                      {change.before?.pctHsCode ?? change.after?.pctHsCode}
                    </td>
                    <td className="p-2 font-mono">{change.before?.rate ?? '—'}</td>
                    <td className="p-2 font-mono">{change.after?.rate ?? '—'}</td>
                    <td className="p-2">
                      {change.after?.exemptionCode ??
                        change.before?.exemptionCode ??
                        'None recorded'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <a
            className="mt-5 inline-flex min-h-11 items-center rounded-[var(--radius-sm)] bg-primary px-4 text-sm font-medium text-primary-foreground"
            download={`tax-profile-review-v${review.before.versionNumber}-v${review.after.versionNumber}.csv`}
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(recordedTaxProfileReviewCsv(review))}`}
          >
            Download evidence CSV
          </a>
        </SectionCard>
      ) : null}
    </Shell>
  );
}

function VersionSelect({
  name,
  label,
  profiles,
  selected,
}: {
  name: string;
  label: string;
  profiles: TaxProfileReviewDto[];
  selected?: string;
}) {
  return (
    <label className="text-sm">
      {label}
      <select className={selectClass} name={name} defaultValue={selected ?? ''} required>
        <option value="">Select version</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            v{profile.versionNumber} · {profile.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Tax profile review"
        description="Compare two approved, recorded branch tax configurations and export their evidence."
      />
      {children}
    </main>
  );
}

function Denied() {
  return (
    <Shell>
      <SectionCard title="Permission required">
        <p className="text-sm text-text-muted">
          Administrator, operational report, financial report, Pharmacy Finance, and Pharmacy
          Reports access are all required. Export is disabled.
        </p>
      </SectionCard>
    </Shell>
  );
}
