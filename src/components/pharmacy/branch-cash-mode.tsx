'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { SelectField } from '@/components/ui/select-field';
import { trpc } from '@/lib/trpc';

type Branch = { id: string; name: string; code: string; cashShiftsEnabled: boolean };

function BranchChoice({ branch }: { branch: Branch }) {
  const field = useId();
  const [choice, setChoice] = useState<boolean | null>(null);
  const utils = trpc.useUtils();
  const save = trpc.pharmacyBranchAssignments.setCashMode.useMutation({
    onSuccess: (saved) => {
      utils.pharmacyBranchAssignments.cashModes.setData(
        undefined,
        (branches) =>
          branches?.map((row) =>
            row.id === branch.id ? { ...row, cashShiftsEnabled: saved.enabled } : row
          ) ?? branches
      );
      setChoice(null);
    },
  });
  const enabled = choice ?? branch.cashShiftsEnabled;
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending && enabled !== branch.cashShiftsEnabled)
          save.mutate({ branchId: branch.id, enabled });
      }}
    >
      <label className="block text-sm font-medium text-text-strong" htmlFor={field}>
        {branch.name} ({branch.code})
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <SelectField
          id={field}
          className="min-h-11 w-full sm:w-56"
          value={enabled ? 'shifts' : 'day'}
          disabled={save.isPending}
          aria-invalid={save.isError || undefined}
          aria-describedby={save.isError ? field + '-error' : undefined}
          onChange={(event) => {
            save.reset();
            setChoice(event.target.value === 'shifts');
          }}
        >
          <option value="day">Single day</option>
          <option value="shifts">Cash shifts</option>
        </SelectField>
        <Button
          className="min-h-11"
          type="submit"
          disabled={save.isPending || enabled === branch.cashShiftsEnabled}
        >
          {save.isPending ? 'Saving…' : 'Save choice'}
        </Button>
      </div>
      {save.isError && (
        <p id={field + '-error'} className="text-sm text-destructive" role="alert">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && (
        <p className="text-sm text-text-body" role="status">
          Saved for {branch.name}.
        </p>
      )}
    </form>
  );
}

export function BranchCashMode() {
  const modes = trpc.pharmacyBranchAssignments.cashModes.useQuery();
  if (modes.data === null) return null;
  return (
    <SectionCard title="How each branch closes">
      {modes.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            The branch choices could not be loaded.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void modes.refetch()}
            disabled={modes.isFetching}
          >
            Try again
          </Button>
        </div>
      ) : !modes.data ? (
        <p className="text-sm text-text-muted" role="status">
          Loading branch choices…
        </p>
      ) : !modes.data.length ? (
        <p className="text-sm text-text-muted">Add an active branch to choose how it closes.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-text-body">
            Choose a single count at day close, or have each cashier count their shift before day
            close. The choice applies when a drawer opens. Drawers already open keep their current
            mode.
          </p>
          {modes.data.map((branch) => (
            <BranchChoice key={branch.id} branch={branch} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
