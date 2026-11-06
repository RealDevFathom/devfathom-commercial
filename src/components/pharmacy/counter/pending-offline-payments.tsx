'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { z } from 'zod';
import { useEntitlements } from '@/components/entitlements-provider';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { isModuleGranted } from '@/lib/module-catalog';
import { trpc } from '@/lib/trpc';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  OfflineHoldList,
  offlineHoldMethods as methods,
  type OfflineHoldRow,
} from './offline-hold-list';
export { OfflineHoldList, type OfflineHoldRow } from './offline-hold-list';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { CounterPaymentRecovery } from './counter-payment-recovery';

const resolution = z.discriminatedUnion('state', [
  z.object({ state: z.literal('RELEASED'), result: z.null() }),
  z.object({
    state: z.literal('SETTLED'),
    result: z
      .object({
        tenderId: z.string().min(1),
        settled: z.boolean(),
        receiptNumber: z.number().int().positive().nullable(),
        remainingMinor: z.number().int().nonnegative(),
      })
      .refine((r) =>
        r.settled
          ? r.receiptNumber !== null && r.remainingMinor === 0
          : r.receiptNumber === null && r.remainingMinor > 0
      ),
  }),
]);

export function PendingOfflinePayments({ initialBranchId = '' }: { initialBranchId?: string }) {
  const { data: session, status } = useSession();
  const entitlements = useEntitlements();
  const user = session?.user;
  if (
    status !== 'authenticated' ||
    !evaluateSessionUser(user).ok ||
    !user?.id ||
    !user.organizationId ||
    user.organizationId !== entitlements.organizationId ||
    !isModuleGranted('pharmacy-counter', entitlements.enabledModules)
  )
    return (
      <SectionCard title="Pending payments unavailable">
        <p role="status">
          {status === 'loading'
            ? 'Checking access…'
            : 'Sign in with an authorized pharmacy account to review pending payments.'}
        </p>
      </SectionCard>
    );
  return (
    <ScopedPendingPayments
      key={JSON.stringify([user.organizationId, user.id])}
      initialBranchId={initialBranchId}
    />
  );
}

function ScopedPendingPayments({ initialBranchId }: { initialBranchId: string }) {
  const [chosen, setChosen] = useState(initialBranchId);
  const branches = trpc.pharmacySales.counterBranches.useQuery(undefined, { retry: false });
  const branchId = chosen || branches.data?.branches[0]?.id || '';
  const permitted =
    branches.isSuccess &&
    !branches.isError &&
    branches.data.branches.some((row) => row.id === branchId);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy counter"
        heading="Pending offline payments"
        description="Recover server bills and review funds before recording payment. This page does not collect money."
        actions={
          <Link
            href="/pharmacy/counter"
            className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
          >
            Back to counter
          </Link>
        }
      />
      <div className="space-y-2">
        <Label htmlFor="pending-payment-branch">Branch</Label>
        <select
          id="pending-payment-branch"
          value={branchId}
          className="h-11 w-full rounded-sm border border-input bg-surface-card px-3 text-sm text-text-strong sm:max-w-sm"
          disabled={branches.isLoading}
          onChange={(event) => setChosen(event.target.value)}
        >
          {!branchId ? <option value="">Choose a branch</option> : null}
          {branches.data?.branches.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name} · {row.code}
            </option>
          ))}
        </select>
      </div>
      {branches.isLoading ? (
        <p role="status">Loading branches…</p>
      ) : !permitted ? (
        <SectionCard title="Branch unavailable">
          <p role="alert">
            This branch could not be verified. Refresh branch access before reviewing funds.
          </p>
          <Button
            variant="outline"
            className="mt-3 min-h-11"
            onClick={() => void branches.refetch()}
          >
            Refresh branches
          </Button>
        </SectionCard>
      ) : (
        <BranchPendingPayments key={branchId} branchId={branchId} />
      )}
    </div>
  );
}

function BranchPendingPayments({ branchId }: { branchId: string }) {
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<OfflineHoldRow | null>(null);
  const [notice, setNotice] = useState('');
  const active = useRef(false);
  const holds = trpc.pharmacySales.pendingOfflinePayments.useQuery(
    { branchId, cursor },
    { retry: false, refetchOnWindowFocus: true }
  );
  const recovery = trpc.pharmacySales.recoverPaymentCollection.useQuery(
    { branchId, attemptId: selected?.id ?? '' },
    { enabled: Boolean(selected), retry: false, refetchOnWindowFocus: true }
  );
  const settings = trpc.pharmacySales.manualPaymentSettings.useQuery(
    { branchId },
    { enabled: Boolean(selected), retry: false }
  );
  const resolve = trpc.pharmacySales.resolveManualCollection.useMutation({ retry: false });
  const detail =
    !holds.isError &&
    !recovery.isError &&
    !recovery.isFetching &&
    recovery.data?.id === selected?.id &&
    recovery.data?.saleId === selected?.saleId &&
    recovery.data?.method === selected?.method &&
    recovery.data?.amountMinor === selected?.amountMinor
      ? recovery.data
      : null;
  return (
    <div className="space-y-6">
      {notice ? (
        <p role="status" className="text-sm text-text-body">
          {notice}
        </p>
      ) : null}
      <OfflineHoldList
        items={holds.data?.items ?? []}
        loading={holds.isFetching}
        error={holds.isError}
        nextCursor={holds.data?.nextCursor ?? null}
        paged={Boolean(cursor)}
        disabled={resolve.isPending}
        selectedId={selected?.id}
        onReview={(row) => {
          setSelected(row);
          setNotice('');
        }}
        onRefresh={() => void holds.refetch()}
        onNext={() => {
          if (holds.data?.nextCursor) setCursor(holds.data.nextCursor);
        }}
        onFirst={() => setCursor(undefined)}
      />
      {selected ? (
        <SectionCard title="Review pending payment">
          <p className="mb-3 break-all text-sm text-text-muted">
            Bill {selected.saleId} · {methods[selected.method] ?? 'External payment'} ·{' '}
            {selected.currency} {formatMinor(selected.amountMinor)}
          </p>
          <p className="mb-4 text-sm text-text-body">
            Only an assigned, authorized Owner or Manager can confirm or release uncertain manual
            funds. Check the branch account and the original counter evidence. No receipt was issued
            by this hold.
          </p>
          {recovery.isFetching ? (
            <p role="status">Checking the latest payment state…</p>
          ) : !detail ? (
            <p role="alert">
              This payment could not be verified. Keep it pending and check its outcome again.
            </p>
          ) : ['SETTLED', 'RELEASED'].includes(detail.state) ? (
            <p role="status">
              {detail.state === 'SETTLED'
                ? 'This payment has already been recorded.'
                : 'This pending claim has already been released.'}
            </p>
          ) : (
            <CounterPaymentRecovery
              key={detail.id}
              attempt={detail}
              settings={
                !settings.isError && !settings.isFetching ? settings.data?.settings : undefined
              }
              pending={resolve.isPending}
              onResolve={async (input) => {
                if (active.current) return;
                active.current = true;
                try {
                  const result = resolution.parse(
                    await resolve.mutateAsync({ branchId, attemptId: detail.id, ...input })
                  );
                  setNotice(
                    result.state === 'SETTLED'
                      ? 'Payment recorded after authorized review. Open the bill to read its current balance and receipt.'
                      : 'Pending claim released after authorized review. No new payment was recorded.'
                  );
                  await recovery.refetch();
                  await holds.refetch();
                } finally {
                  active.current = false;
                }
              }}
            />
          )}
          {settings.isError ? (
            <p role="alert" className="mt-3 text-sm text-text-body">
              Current merchant policy could not be read. Confirmation remains subject to server
              verification.
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={resolve.isPending || recovery.isFetching}
              onClick={() => void recovery.refetch()}
            >
              Check payment outcome
            </Button>
            <Link
              href={`/pharmacy/counter?branchId=${encodeURIComponent(branchId)}&orderSaleId=${encodeURIComponent(selected.saleId)}`}
              className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
            >
              Open bill in counter
            </Link>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
