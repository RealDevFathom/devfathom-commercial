'use client';

import { useId, useState } from 'react';

import { Switch } from '@/components/ui/switch';
import { trpc } from '@/lib/trpc';

export type OtherBranchAvailabilityView = { enabled: boolean; canChange: boolean };

/**
 * DEV-907: the owner's switch for the counter's "also in stock at another branch"
 * line. Off by default. The server enforces who may change it; the disabled
 * switch only explains that to everyone else.
 */
export function OtherBranchAvailabilityPanel({
  enabled,
  canChange,
  pending,
  notice,
  onChange,
}: OtherBranchAvailabilityView & {
  pending: boolean;
  notice: string | null;
  onChange: (enabled: boolean) => void;
}) {
  const labelId = useId();
  const helpId = useId();
  return (
    <div className="space-y-3">
      <div className="flex min-h-11 items-center gap-3">
        <Switch
          checked={enabled}
          disabled={!canChange || pending}
          onCheckedChange={(next) => onChange(next)}
          aria-labelledby={labelId}
          aria-describedby={helpId}
        />
        <span id={labelId} className="text-sm font-medium text-text-strong">
          Show when another branch has an out-of-stock item
        </span>
      </div>
      <div id={helpId} className="space-y-1 text-sm text-text-muted">
        <p>
          When this branch has none of an item, the counter shows one line such as “Also in stock at
          Gulberg”. It names the branch only: no quantities, prices, batches or customers.
        </p>
        <p>
          Controlled drugs are never shown. The customer buys and collects the item at that branch;
          this counter cannot take payment for it.
        </p>
        {!canChange ? <p>Only the owner can change this setting.</p> : null}
      </div>
      {notice ? (
        <p className="text-sm text-text-body" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

export function OtherBranchAvailabilityConsole({
  initial,
}: {
  initial: OtherBranchAvailabilityView;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const setting = trpc.pharmacyBranchAssignments.otherBranchAvailability.useQuery(undefined, {
    initialData: initial,
  });
  const save = trpc.pharmacyBranchAssignments.setOtherBranchAvailability.useMutation({
    onSuccess: async (saved) => {
      setNotice(
        saved.enabled ? 'Other-branch availability is on.' : 'Other-branch availability is off.'
      );
      await setting.refetch();
    },
    onError: (error) => setNotice(error.message),
  });
  const data = setting.data ?? initial;
  return (
    <OtherBranchAvailabilityPanel
      enabled={data.enabled}
      canChange={data.canChange}
      pending={save.isPending}
      notice={notice}
      onChange={(enabled) => save.mutate({ enabled })}
    />
  );
}
