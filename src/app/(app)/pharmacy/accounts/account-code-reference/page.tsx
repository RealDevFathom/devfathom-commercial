import { assignedRegisterBranchIds } from '@/lib/pharmacy/controlled-register';
import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can, subjectFromSession } from '@/lib/abac';
import { isSessionUsable } from '@/lib/auth/session-state';
import { hasModule } from '@/lib/entitlements';
import { accountCodeReference } from '@/lib/pharmacy/accounts/account-code-reference';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Account code reference · Pharmacy' };

type SearchParams = Promise<{ branch?: string | string[] }>;

const MAX_BRANCH_ID_LENGTH = 128;

const header = (
  <PageHeader
    eyebrow="Pharmacy accounts"
    heading="Account code reference"
    description="Canonical account codes and the debit or credit side that normally increases each account."
  />
);

function unavailable(title: string, detail: string) {
  return (
    <div className="min-w-0 space-y-6">
      {header}
      <SectionCard title={title} titleLevel={2}>
        <p className="text-sm text-text-muted">{detail}</p>
      </SectionCard>
    </div>
  );
}

export default async function AccountCodeReferencePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const actor = await resolveTenantActor();
  if (!actor) return unavailable('Permission required', 'Sign in to an authorized workspace.');

  const ctx = await createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  const user = ctx.session?.user;
  if (!user || !isSessionUsable(user) || !hasModule(ctx.entitlements, 'pharmacy-reports')) {
    return unavailable(
      'Reference unavailable',
      'An active session and the Pharmacy reports module are required.'
    );
  }

  if (user.role !== 'ADMIN') {
    const subject = subjectFromSession(user);
    const decisionContext = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
    const [operational, financial] = await Promise.all([
      can(subject, 'reports:operational', undefined, decisionContext),
      can(subject, 'reports:financial', undefined, decisionContext),
    ]);
    if (!operational || !financial) {
      return unavailable(
        'Permission required',
        'Administrator access or both operational and financial report permissions are required.'
      );
    }
  }

  const hasRequestedBranch = Object.prototype.hasOwnProperty.call(query, 'branch');
  const requestedBranch =
    typeof query.branch === 'string' &&
    query.branch.length > 0 &&
    query.branch.length <= MAX_BRANCH_ID_LENGTH
      ? query.branch
      : undefined;
  if (hasRequestedBranch && !requestedBranch) {
    return unavailable(
      'Branch unavailable',
      'The requested branch is not an active branch in this workspace.'
    );
  }

  const organizationId = ctx.entitlements.organizationId;
  const activeBranches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });
  const assigned =
    user.role === 'ADMIN'
      ? null
      : new Set(await assignedRegisterBranchIds(ctx.db, organizationId, user.id));
  const branches = assigned ? activeBranches.filter(({ id }) => assigned.has(id)) : activeBranches;
  const branch = hasRequestedBranch
    ? branches.find(({ id }) => id === requestedBranch)
    : branches[0];
  if (!branch) {
    return unavailable(
      hasRequestedBranch ? 'Branch unavailable' : 'No active branch',
      hasRequestedBranch
        ? 'The requested branch is not an active branch in this workspace.'
        : 'Create an active pharmacy branch before viewing this reference.'
    );
  }

  const rows = accountCodeReference();
  return (
    <div className="min-w-0 space-y-6">
      {header}
      <SectionCard title="Canonical normal sides" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          Read-only reference for {branch.name}. These values come directly from the shared journal
          definition and do not create or change accounts, balances, or postings.
        </p>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account code</TableHead>
                <TableHead>Normal side</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.code}>
                  <TableCell className="font-mono text-xs font-medium">{row.code}</TableCell>
                  <TableCell>{row.normalSide}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}
