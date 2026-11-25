'use client';
import { trpc } from '@/lib/trpc';
import { FINANCE_ACCOUNT_LABELS } from '@/lib/finance/account-labels';

export function ProviderRefundAccount() {
  const query = trpc.organizationAdmin.pharmacySettings.refundMapping.useQuery(undefined, {
    retry: false,
  });
  if (query.isPending) return <p role="status">Loading account…</p>;
  if (!query.data)
    return (
      <p role="alert">
        {query.error?.data?.code === 'FORBIDDEN'
          ? 'Finance access is required to view this account.'
          : 'The provider refund account could not be loaded.'}
      </p>
    );
  return (
    <dl>
      <dt className="text-sm text-text-muted">Current liability</dt>
      <dd>{FINANCE_ACCOUNT_LABELS[query.data.terminalRefundAccount]}</dd>
    </dl>
  );
}
