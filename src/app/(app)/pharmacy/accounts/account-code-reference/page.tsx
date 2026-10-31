import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { accountCodeReference } from '@/lib/pharmacy/accounts/account-code-reference';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { tenantContext } from '../../purchasing/_lib/console';

export const metadata: Metadata = { title: 'Account-code reference · Pharmacy accounts' };

type Query = Partial<Record<string, string | string[]>>;
type Branch = { id: string; name: string };
type Access =
  | { kind: 'denied' }
  | { kind: 'invalid-branch' }
  | { kind: 'no-branch' }
  | { kind: 'allowed'; branch: Branch | null; branchCount: number };

/**
 * Every gate is decided before the reference is derived or any row rendered:
 * tenant actor and organization, the Pharmacy reports module, the existing
 * `reports:operational` capability and active tenant-branch scope (through the
 * production Reports `branches` procedure), and owner (ADMIN) or
 * `reports:financial` authority. An explicit branch that is duplicated or not
 * an authorized active branch denies; it never falls back to another branch.
 */
async function referenceAccess(query: Query): Promise<Access> {
  const ctx = await tenantContext();
  const user = ctx?.session?.user;
  if (
    !ctx ||
    !user?.id ||
    !ctx.entitlements.organizationId ||
    ctx.organization?.id !== ctx.entitlements.organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-reports')
  )
    return { kind: 'denied' };
  const financial =
    user.role === 'ADMIN' ||
    (await can(subjectFromSession({ ...user, id: user.id }), 'reports:financial', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }));
  if (!financial) return { kind: 'denied' };
  // Enforces `reports:operational`, the module and active tenant-branch scope.
  let branches: Branch[];
  try {
    ({ branches } = await pharmacyReportsRouter.createCaller(ctx).branches());
  } catch (cause) {
    if (cause instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(cause.code))
      return { kind: 'denied' };
    throw cause;
  }
  const requested = query.branch;
  if (Array.isArray(requested)) return { kind: 'invalid-branch' };
  if (requested !== undefined) {
    const branch = branches.find((item) => item.id === requested);
    if (!branch) return { kind: 'invalid-branch' };
    return { kind: 'allowed', branch, branchCount: branches.length };
  }
  if (!branches.length) return { kind: 'no-branch' };
  return {
    kind: 'allowed',
    branch: branches.length === 1 ? branches[0]! : null,
    branchCount: branches.length,
  };
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SectionCard title={title} titleLevel={2}>
      <p role="status" className="text-sm text-text-muted">
        {children}
      </p>
    </SectionCard>
  );
}

const NOTICES: Record<Exclude<Access['kind'], 'allowed'> | 'unavailable', [string, string]> = {
  denied: [
    'Account reference access required',
    'An active session, the Pharmacy reports module, operational report permission, and owner or financial report permission are required. Ask your workspace administrator to review access.',
  ],
  'invalid-branch': [
    'Branch not available',
    'The requested branch is not an authorized active branch for your account. Choose a branch you can access, or open this page without a branch.',
  ],
  'no-branch': [
    'No active branch',
    'No authorized active pharmacy branch is available to your account. Ask your workspace administrator to review branch access.',
  ],
  unavailable: [
    'Reference access unavailable',
    'Your session, permissions or branch scope could not be verified. Reload to retry, or contact your workspace administrator.',
  ],
};

export default async function AccountCodeReferencePage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const heading = (
    <PageHeader
      eyebrow="Pharmacy accounts"
      heading="Account-code reference"
      description="Read-only list of the canonical ledger account codes and the side that increases each one."
    />
  );
  let access: Access | null = null;
  try {
    access = await referenceAccess(query);
  } catch {
    // Any gate failure yields a safe access state; nothing below the gate is rendered.
  }
  if (!access || access.kind !== 'allowed') {
    const [title, body] = NOTICES[access?.kind ?? 'unavailable'];
    return (
      <main className="min-w-0 space-y-6">
        {heading}
        <Notice title={title}>{body}</Notice>
      </main>
    );
  }

  const reference = accountCodeReference();
  return (
    <main className="min-w-0 space-y-6">
      {heading}
      <SectionCard title="Normal sides" titleLevel={2}>
        <div className="grid gap-6 sm:grid-cols-3">
          <Stat label="Account codes" value={reference.rows.length} />
          <Stat label="Debit-normal" value={reference.debitCount} />
          <Stat label="Credit-normal" value={reference.creditCount} />
        </div>
        <p className="mt-4 text-sm text-text-muted">
          {access.branch
            ? `Branch context: ${access.branch.name}. `
            : `Available to all ${access.branchCount} authorized active branches. `}
          The codes are shared by every branch. This reference shows no balances, hierarchy or
          postings and cannot change any account.
        </p>
      </SectionCard>
      <SectionCard title="Canonical account codes" titleLevel={2}>
        <div
          role="region"
          aria-label="Canonical account codes"
          tabIndex={0}
          className="rounded-md border border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Table className="min-w-[520px] tabular-nums">
            <TableHeader>
              <TableRow>
                <TableHead className="font-mono text-xs uppercase text-text-muted">Code</TableHead>
                <TableHead className="font-mono text-xs uppercase text-text-muted">
                  Account
                </TableHead>
                <TableHead className="font-mono text-xs uppercase text-text-muted">
                  Normal side
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reference.rows.map((row) => (
                <TableRow key={row.code} className="hover:bg-surface-sunken">
                  <TableCell className="font-mono text-xs text-text-strong">{row.code}</TableCell>
                  <TableCell className="text-text-body">{row.label}</TableCell>
                  <TableCell className="font-mono text-xs text-text-strong">
                    {row.normalSide === 'DEBIT' ? 'Debit' : 'Credit'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="mt-4 text-sm text-text-muted">
          A debit-normal account increases with debits; a credit-normal account increases with
          credits. Reports read balances with this sign convention.
        </p>
      </SectionCard>
    </main>
  );
}
