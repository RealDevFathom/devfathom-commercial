import { workspaceTimezone } from '@/lib/timezone';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { can, subjectFromSession } from '@/lib/abac';
import { businessDateToUtcDate, resolveBusinessDate } from '@/lib/restaurant/business-date';
import { hasModule } from '@/lib/entitlements';
import { restaurantSopExecutionRouter } from '@/server/routers/restaurant-sop-execution';
import { createTRPCContext } from '@/server/trpc';

const route = '/restaurant/sop/reports';
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';
const departments = [
  'LEADERSHIP',
  'ENGINEERING',
  'PRODUCT',
  'QUALITY',
  'MARKETING',
  'DESIGN',
] as const;

type SearchParams = Promise<
  Record<'branch' | 'from' | 'to' | 'department', string | string[] | undefined>
>;
const queryValue = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const validDate = (value: string | undefined, fallback: string) => {
  if (!value) return fallback;
  try {
    businessDateToUtcDate(value);
    return value;
  } catch {
    return fallback;
  }
};

function State({ kind }: { kind: 'disabled' | 'permission' | 'error' }) {
  const copy = {
    disabled: ['SOP reports unavailable', 'Enable the Restaurant SOP module to view reporting.'],
    permission: ['Permission denied', 'Operational reports access and branch access are required.'],
    error: [
      'SOP report could not load',
      'No SOP data was changed. Check the filters and try again.',
    ],
  }[kind];
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="SOP reports"
        description="Outcome and performance reconciliation for completed SOP work."
      />
      <SectionCard title={copy[0]} titleLevel={2}>
        <p className="text-sm text-text-muted">{copy[1]}</p>
        {kind === 'error' ? (
          <Link className={`${buttonVariants({ variant: 'secondary' })} mt-4`} href={route}>
            Reset filters
          </Link>
        ) : null}
      </SectionCard>
    </div>
  );
}

export default async function SopReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const ctx = await createTRPCContext();
  const user = ctx.session?.user;
  if (!hasModule(ctx.entitlements, 'restaurant-sop')) return <State kind="disabled" />;
  if (
    !user ||
    !(await can(subjectFromSession(user), 'reports:operational', undefined, {
      db: ctx.db,
      source: 'TRPC',
    }))
  ) {
    return <State kind="permission" />;
  }

  const caller = restaurantSopExecutionRouter.createCaller(ctx);
  const branches = await caller.reportBranches();
  if (!branches.length) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Restaurant operations"
          heading="SOP reports"
          description="Outcome and performance reconciliation for completed SOP work."
        />
        <SectionCard title="No active branches" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Create or activate a branch before running an SOP report.
          </p>
        </SectionCard>
      </div>
    );
  }

  const branch = branches.find((item) => item.id === queryValue(query.branch)) ?? branches[0];
  const today = resolveBusinessDate(
    new Date(),
    workspaceTimezone(branch?.timezone ?? ctx.organization?.timezone),
    branch?.businessDayCutoff
  );
  const weekAgo = new Date(`${today}T00:00:00Z`);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 6);
  const from = validDate(queryValue(query.from), isoDate(weekAgo));
  const to = validDate(queryValue(query.to), today);
  const rawDepartment = queryValue(query.department);
  const department = departments.find((item) => item === rawDepartment);

  let report;
  try {
    report = await caller.report({ branchId: branch.id, from, to, department });
  } catch (error) {
    return (
      <State
        kind={error instanceof TRPCError && error.code === 'FORBIDDEN' ? 'permission' : 'error'}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="SOP reports"
        description="Outcomes, timeliness, proof, verification, escalation and performance score only."
        actions={
          <Link className={buttonVariants({ variant: 'secondary' })} href="/restaurant/sop">
            Open board
          </Link>
        }
      />
      <SectionCard title="Report filters" eyebrow="URL-persisted" titleLevel={2}>
        <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" method="get">
          <label className="text-sm text-text-body">
            Branch
            <select className={selectClass} defaultValue={branch.id} name="branch">
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-text-body">
            From
            <Input className="mt-1 min-h-11" defaultValue={from} name="from" type="date" />
          </label>
          <label className="text-sm text-text-body">
            To
            <Input className="mt-1 min-h-11" defaultValue={to} name="to" type="date" />
          </label>
          <label className="text-sm text-text-body">
            Department
            <select className={selectClass} defaultValue={department ?? ''} name="department">
              <option value="">All departments</option>
              {departments.map((item) => (
                <option key={item} value={item}>
                  {item.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <Button className="min-h-11 self-end" type="submit">
            Apply filters
          </Button>
        </form>
      </SectionCard>

      {report.total === 0 ? (
        <SectionCard title="No SOP results">
          <p className="text-sm text-text-muted">
            No occurrences match this branch, date range and department combination.
          </p>
        </SectionCard>
      ) : (
        <>
          <SectionCard title="Performance ledger" eyebrow={`${branch.name} · ${from} to ${to}`}>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-6">
              <Stat label="Occurrences" value={report.total} />
              <Stat label="On time" value={report.onTime} />
              <Stat label="With proof" value={report.withProof} />
              <Stat label="Verified" value={report.verified} />
              <Stat label="Escalated" value={report.escalated} />
              <Stat label="Performance" value={`${report.performanceScore}%`} />
            </div>
          </SectionCard>
          <SectionCard title="Outcome reconciliation">
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Object.entries(report.outcomes).map(([status, count]) => (
                <div
                  className="rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-4"
                  key={status}
                >
                  <dt className="font-mono text-xs uppercase tracking-wider text-text-muted">
                    {status}
                  </dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums text-text-strong">
                    {count}
                  </dd>
                </div>
              ))}
            </dl>
          </SectionCard>
          <SectionCard title="People attribution" eyebrow="Owner / completer">
            <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-border-subtle">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                  <tr>
                    <th className="p-3">Person</th>
                    <th className="p-3">Department</th>
                    <th className="p-3 text-right">Owned</th>
                    <th className="p-3 text-right">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {report.attribution.map((person) => (
                    <tr className="border-t border-border-subtle" key={person.staffProfileId}>
                      <td className="p-3 text-text-strong">{person.displayName}</td>
                      <td className="p-3 text-text-muted">
                        {person.department?.toLowerCase() ?? 'Unlinked'}
                      </td>
                      <td className="p-3 text-right tabular-nums">{person.owned}</td>
                      <td className="p-3 text-right tabular-nums">{person.completed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}
