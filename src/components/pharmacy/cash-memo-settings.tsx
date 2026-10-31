'use client';

import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

function BranchCashMemoPolicy({ branchId }: { branchId: string }) {
  const utils = trpc.useUtils();
  const policy = trpc.pharmacySales.counterCashMemoPolicy.useQuery({ branchId });
  const save = trpc.pharmacySales.counterSaveCashMemoPolicy.useMutation();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const required = draft ?? policy.data?.buyerNameRequired ?? false;

  async function submit() {
    if (!policy.data || policy.isError || saving.current) return;
    saving.current = true;
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      const result = await save.mutateAsync({ branchId, buyerNameRequired: required });
      utils.pharmacySales.counterCashMemoPolicy.setData({ branchId }, (current) =>
        current ? { ...current, buyerNameRequired: result.buyerNameRequired } : current
      );
      setDraft(null);
      setNotice('Cash memo policy saved. It applies to future payments at this branch.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The policy could not be saved. Retry.');
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  if (policy.isError) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          The cash memo policy could not be loaded. Check your access and retry.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={policy.isFetching}
          onClick={() => void policy.refetch()}
        >
          Retry policy
        </Button>
      </div>
    );
  }
  if (!policy.data) {
    return (
      <p role="status" className="text-sm text-text-muted">
        Loading cash memo policy…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <Label htmlFor="cash-memo-name-required" className="flex min-h-11 items-center gap-3">
        <input
          id="cash-memo-name-required"
          type="checkbox"
          checked={required}
          disabled={pending}
          aria-describedby="cash-memo-policy-help"
          onChange={(event) => {
            setDraft(event.target.checked);
            setNotice(null);
            setError(null);
          }}
          className="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
        Require a buyer name before payment
      </Label>
      <p id="cash-memo-policy-help" className="text-sm text-text-muted">
        Applies when this branch issues a Sindh cash memo. A saved buyer name or linked customer
        name is required when enabled. Existing receipts keep their issued details.
        {!policy.data.cashMemo ? ' This branch currently uses the standard receipt.' : ''}
      </p>
      <Button
        type="button"
        className="min-h-11"
        disabled={pending || required === policy.data.buyerNameRequired}
        onClick={() => void submit()}
      >
        {pending ? 'Saving…' : 'Save cash memo policy'}
      </Button>
      {notice ? (
        <p role="status" className="text-sm text-text-body">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Mounted only after the branch-settings page's administrator access check. */
export function CashMemoSettings({
  branches,
}: {
  branches: { id: string; code: string; name: string }[];
}) {
  const [selectedBranch, setSelectedBranch] = useState(branches[0]?.id ?? '');
  const branchId = branches.some((branch) => branch.id === selectedBranch)
    ? selectedBranch
    : (branches[0]?.id ?? '');

  if (!branchId) {
    return <p className="text-sm text-text-body">No active pharmacy branch is available.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="sm:max-w-sm">
        <Label htmlFor="cash-memo-policy-branch">Cash memo branch</Label>
        <select
          id="cash-memo-policy-branch"
          value={branchId}
          onChange={(event) => setSelectedBranch(event.target.value)}
          className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-body outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
        >
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name} ({branch.code})
            </option>
          ))}
        </select>
      </div>
      <BranchCashMemoPolicy key={branchId} branchId={branchId} />
    </div>
  );
}
