'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
          ? 'Finance access is required to view the provider refund account.'
          : 'The account setting could not be loaded. Reload the page to try again.'}
      </p>
    );
  if (!query.data.canEdit) {
    const mapping = query.data;
    const label =
      accounts.find((item) => item.value === mapping.terminalRefundAccount)?.label ??
      (mapping.usesCustomFinanceChart ? 'No account mapped' : 'Card refunds payable (provider)');
    return (
      <dl className="space-y-4">
        <div>
          <dt className="text-sm text-text-muted">Chart of accounts</dt>
          <dd>{mapping.usesCustomFinanceChart ? 'Custom chart' : 'Default chart'}</dd>
        </div>
        <div>
          <dt className="text-sm text-text-muted">Provider refund liability account</dt>
          <dd>{label}</dd>
        </div>
      </dl>
    );
  }
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
  const [pin, setPin] = useState('');
  const [saved, setSaved] = useState(mapping);
  const mutation = trpc.organizationAdmin.pharmacySettings.setRefundMapping.useMutation({
    onSuccess: (_result, submitted) =>
      setSaved({
        terminalRefundAccount: submitted.account,
        usesCustomFinanceChart: submitted.usesCustomFinanceChart,
      }),
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
        mutation.mutate({ usesCustomFinanceChart: custom, account, pin });
        setPin('');
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
      <div className="space-y-2">
        <Label htmlFor="refund-approval">Approval code or staff PIN</Label>
        <Input
          id="refund-approval"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          minLength={4}
          maxLength={8}
          required
          value={pin}
          onChange={(event) => setPin(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        disabled={
          mutation.isPending ||
          !/^\d{4,8}$/.test(pin) ||
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
