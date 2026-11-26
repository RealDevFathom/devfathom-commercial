'use client';

import { Switch } from '@/components/ui/switch';
import { trpc } from '@/lib/trpc';

type Settings = {
  canChange: boolean;
  branches: { id: string; name: string; requireSecondPharmacist: boolean }[];
};

export function ControlledWitnessSettings({ initial }: { initial: Settings }) {
  const query = trpc.pharmacyBranchAssignments.controlledWitnessSettings.useQuery(undefined, {
    initialData: initial,
  });
  const update = trpc.pharmacyBranchAssignments.setControlledWitness.useMutation({
    onSuccess: () => query.refetch().then(() => undefined),
  });
  const settings = query.data ?? initial;
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-body">
        Choose which branches require an independent pharmacist to countersign.
      </p>
      {!settings.canChange && (
        <p className="text-sm text-text-muted">
          Only the pharmacy owner can change this requirement.
        </p>
      )}
      {settings.branches.length === 0 && (
        <p className="text-sm text-text-muted">No active branches.</p>
      )}
      {settings.branches.map((branch) => (
        <label
          key={branch.id}
          className="flex min-h-11 items-center gap-3 text-sm text-text-strong"
        >
          <Switch
            checked={branch.requireSecondPharmacist}
            disabled={!settings.canChange || update.isPending || query.isError}
            aria-label={`Require a second pharmacist for controlled medicines at ${branch.name}`}
            onCheckedChange={(required) => update.mutate({ branchId: branch.id, required })}
          />
          {branch.name}
        </label>
      ))}
      {update.error || query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {update.error?.message ?? query.error?.message}
        </p>
      ) : update.isPending || update.isSuccess ? (
        <p role="status" className="text-sm text-text-muted">
          {update.isPending ? 'Saving the branch requirement…' : 'Branch requirement saved.'}
        </p>
      ) : null}
    </div>
  );
}
