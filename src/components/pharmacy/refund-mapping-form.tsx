'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { FinanceAccountCode } from '@/generated/prisma/client';
import { trpc } from '@/lib/trpc';

type Mapping = {
  terminalRefundAccount: FinanceAccountCode | null;
  usesCustomFinanceChart: boolean;
};
export function RefundMappingForm({
  accounts,
}: {
  accounts: { value: FinanceAccountCode; label: string }[];
}) {
  const query = trpc.organizationAdmin.pharmacySettings.refundMapping.useQuery(undefined, {
    retry: false,
  });
  if (query.isPending) return <p role="status">Loading account settings…</p>;
  if (!query.data)
    return (
      <p role="alert">
        {query.error?.data?.code === 'FORBIDDEN'
          ? 'Only the owner or accountant can change the provider refund account.'
          : 'The account setting could not be loaded. Reload the page to try again.'}
      </p>
    );
  return <MappingFields mapping={query.data} accounts={accounts} />;
}

function MappingFields({
  mapping,
  accounts,
}: {
  mapping: Mapping;
  accounts: { value: FinanceAccountCode; label: string }[];
}) {
  const [custom, setCustom] = useState(mapping.usesCustomFinanceChart);
  const [account, setAccount] = useState<FinanceAccountCode | null>(mapping.terminalRefundAccount);
  const [saved, setSaved] = useState(mapping);
  const mutation = trpc.organizationAdmin.pharmacySettings.setRefundMapping.useMutation({
    onSuccess: () => setSaved({ terminalRefundAccount: account, usesCustomFinanceChart: custom }),
  });
  const choices = [
    {
      value: '',
      label: custom ? 'No account mapped' : 'Use default · Card refunds payable (provider)',
    },
    ...accounts,
  ];
  return (
    <form
      className="max-w-xl space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate({ usesCustomFinanceChart: custom, account });
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="refund-chart">Chart of accounts</Label>
        <Select
          value={custom ? 'custom' : 'default'}
          items={{ custom: 'Custom chart', default: 'Default chart' }}
          onValueChange={(value) => {
            if (value) {
              setCustom(value === 'custom');
              mutation.reset();
            }
          }}
        >
          <SelectTrigger className="w-full rounded-control" id="refund-chart">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default chart</SelectItem>
            <SelectItem value="custom">Custom chart</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="refund-account">Provider refund liability account</Label>
        <Select
          items={choices}
          value={account ?? ''}
          onValueChange={(value) => {
            setAccount(accounts.find((item) => item.value === value)?.value ?? null);
            mutation.reset();
          }}
        >
          <SelectTrigger className="w-full rounded-control" id="refund-account">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {custom && !account && (
        <p className="text-sm text-text-muted">
          Refund booking is unavailable until you map a liability account.
        </p>
      )}
      <Button
        type="submit"
        disabled={
          mutation.isPending ||
          (account === saved.terminalRefundAccount && custom === saved.usesCustomFinanceChart)
        }
      >
        {mutation.isPending ? 'Saving…' : 'Save mapping'}
      </Button>
      {mutation.isError && (
        <p className="text-sm text-destructive" role="alert">
          {mutation.error.message}
        </p>
      )}
      {mutation.isSuccess && <p role="status">Provider refund mapping saved.</p>}
    </form>
  );
}
