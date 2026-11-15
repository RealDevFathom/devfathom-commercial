import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { financeAccountLabel } from '@/lib/finance/account-labels';
import {
  JOURNAL_VOUCHER_CATALOG,
  JOURNAL_VOUCHER_PURPOSE_LABELS,
  JOURNAL_VOUCHER_PURPOSES,
} from '@/lib/pharmacy/accounts/coa';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyGeneralJournalRouter } from '@/server/routers/pharmacy-general-journal';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'General journal vouchers · Pharmacy accounts' };

type Query = { branch?: string | string[] };

type VoucherRow = {
  id: string;
  reference: string;
  purpose: string;
  status: string;
  version: number;
  currency: string;
  occurredAt: Date;
  reason: string;
  evidenceReference: string;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  lines: Array<{ lineNumber: number; accountCode: string; side: string; amountMinor: number }>;
};

type State =
  | { kind: 'initial' }
  | { kind: 'invalid' }
  | { kind: 'denied' }
  | { kind: 'failure' }
  | { kind: 'loaded'; branchId: string; vouchers: VoucherRow[]; retrievedAt: Date };

const STATUS_TONES: Record<string, StatusTone> = {
  DRAFT: 'info',
  POSTED: 'success',
  REVERSED: 'warning',
  CANCELLED: 'neutral',
};

function minor(value: number): string {
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? '-' : ''}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function parseBranch(query: Query): { branchId?: string; invalid?: boolean } {
  if (query.branch === undefined) return {};
  if (typeof query.branch !== 'string') return { invalid: true };
  const branchId = query.branch.trim();
  if (!branchId || branchId.length > 128) return { invalid: true };
  return { branchId };
}

function BranchForm({ branchId }: { branchId?: string }) {
  return (
    <SectionCard title="Branch" titleLevel={2}>
      <form method="get" className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
        <label className="grid gap-2 text-sm">
          Branch ID
          <Input
            className="min-h-11"
            name="branch"
            defaultValue={branchId}
            maxLength={128}
            required
            aria-describedby="branch-help"
          />
        </label>
        <Button type="submit" className="min-h-11">
          Show vouchers
        </Button>
      </form>
      <p id="branch-help" className="mt-3 text-sm text-text-muted">
        The branch selection narrows the request; it does not grant access to that branch.
      </p>
    </SectionCard>
  );
}

function Catalog() {
  return (
    <SectionCard title="Allowed voucher accounts" titleLevel={2}>
      <p className="text-sm text-text-muted">
        Manual journal vouchers accept one purpose only. Every other account, side or purpose is
        refused by the server.
      </p>
      {JOURNAL_VOUCHER_PURPOSES.map((purpose) => (
        <div key={purpose} className="mt-4">
          <h3 className="font-semibold">{JOURNAL_VOUCHER_PURPOSE_LABELS[purpose]}</h3>
          <div className="overflow-x-auto">
            <table className="mt-3 w-full min-w-max text-sm">
              <thead className="font-mono text-xs uppercase">
                <tr>
                  <th scope="col" className="p-3 text-left">
                    Account
                  </th>
                  <th scope="col" className="p-3 text-left">
                    Side
                  </th>
                  <th scope="col" className="p-3 text-left">
                    Meaning
                  </th>
                </tr>
              </thead>
              <tbody>
                {JOURNAL_VOUCHER_CATALOG[purpose].map((rule) => (
                  <tr
                    key={`${rule.accountCode}:${rule.side}`}
                    className="border-t border-border-subtle"
                  >
                    <th scope="row" className="p-3 text-left font-medium" title={rule.accountCode}>
                      {financeAccountLabel(rule.accountCode)}
                    </th>
                    <td className="p-3">{rule.side === 'DEBIT' ? 'Debit' : 'Credit'}</td>
                    <td className="p-3 text-text-muted">{rule.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </SectionCard>
  );
}

function Notice({ state }: { state: Exclude<State, { kind: 'loaded' }> }) {
  const content = {
    initial: [
      'Choose a branch',
      'Enter one branch to list its journal vouchers. No voucher has been read.',
    ],
    invalid: ['Branch needs attention', 'Enter one branch ID of at most 128 characters.'],
    denied: [
      'Journal vouchers unavailable',
      'Your authenticated tenant, active branch, Pharmacy Finance licence and owner finance permissions must all allow this read.',
    ],
    failure: [
      'Journal vouchers could not be loaded',
      'The voucher register could not be read. No stale data is shown; retry the request.',
    ],
  }[state.kind];
  return (
    <SectionCard title={content[0]} titleLevel={2}>
      <p role={state.kind === 'initial' ? undefined : 'alert'} className="text-sm text-text-muted">
        {content[1]}
      </p>
    </SectionCard>
  );
}

function Register({ state }: { state: Extract<State, { kind: 'loaded' }> }) {
  return (
    <SectionCard title="Voucher register" titleLevel={2}>
      <p className="text-sm text-text-muted">
        Branch {state.branchId}. Retrieved {state.retrievedAt.toISOString()}. Amounts are in minor
        units shown as major.minor.
      </p>
      {state.vouchers.length === 0 ? (
        <p className="mt-4 text-sm">
          No journal vouchers exist for this branch yet. Drafts saved through the voucher commands
          appear here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="mt-3 w-full min-w-max text-sm tabular-nums">
            <thead className="font-mono text-xs uppercase">
              <tr>
                {['Reference', 'Status', 'Date (UTC)', 'Debit', 'Credit', 'Amount', 'Evidence'].map(
                  (label) => (
                    <th key={label} scope="col" className="p-3 text-left">
                      {label}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {state.vouchers.map((voucher) => {
                const debit = voucher.lines.find((line) => line.side === 'DEBIT');
                const credit = voucher.lines.find((line) => line.side === 'CREDIT');
                return (
                  <tr key={voucher.id} className="border-t border-border-subtle hover:bg-muted/40">
                    <th scope="row" className="p-3 text-left font-medium">
                      {voucher.reference}
                      <span className="block text-xs text-text-muted">v{voucher.version}</span>
                    </th>
                    <td className="p-3">
                      <StatusPill
                        status={voucher.status}
                        tone={STATUS_TONES[voucher.status] ?? 'neutral'}
                        label={voucher.status.toLowerCase()}
                      />
                    </td>
                    <td className="p-3">{voucher.occurredAt.toISOString().slice(0, 10)}</td>
                    <td className="p-3">{debit ? financeAccountLabel(debit.accountCode) : '—'}</td>
                    <td className="p-3">
                      {credit ? financeAccountLabel(credit.accountCode) : '—'}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {voucher.currency} {minor(debit?.amountMinor ?? 0)}
                    </td>
                    <td className="p-3">{voucher.evidenceReference}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

export default async function GeneralJournalPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const parsed = parseBranch(query);
  let state: State = parsed.invalid ? { kind: 'invalid' } : { kind: 'initial' };

  if (parsed.branchId) {
    try {
      const actor = await resolveTenantActor();
      if (!actor) {
        state = { kind: 'denied' };
      } else {
        const ctx = await createTRPCContext({
          session: actor.session,
          organization: actor.organization,
          support: actor.support,
        });
        const caller = pharmacyGeneralJournalRouter.createCaller(ctx);
        const result = await caller.list({ branchId: parsed.branchId, take: 50 });
        if (
          result.scope.organizationId !== actor.organization.id ||
          result.scope.branchId !== parsed.branchId
        ) {
          throw new Error('Voucher register scope mismatch.');
        }
        state = {
          kind: 'loaded',
          branchId: result.scope.branchId,
          vouchers: result.vouchers,
          retrievedAt: result.retrievedAt,
        };
      }
    } catch (error) {
      state =
        error instanceof TRPCError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)
          ? { kind: 'denied' }
          : { kind: 'failure' };
    }
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="General journal vouchers"
        description="Review non-trade operating accrual vouchers for one branch and the only accounts they may use."
      />
      <BranchForm branchId={typeof query.branch === 'string' ? query.branch : undefined} />
      {state.kind === 'loaded' ? <Register state={state} /> : <Notice state={state} />}
      <Catalog />
    </div>
  );
}
