'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function VisitForm({
  branches,
  initialBranchId,
  visitId,
  action,
}: {
  branches: { id: string; name: string }[];
  initialBranchId?: string;
  visitId: string;
  action: (
    state: { message: string; success: boolean },
    data: FormData
  ) => Promise<{ message: string; success: boolean }>;
}) {
  const [state, submit, pending] = useActionState(action, { message: '', success: false });
  return (
    <form action={submit} className="space-y-4">
      <input type="hidden" name="id" value={visitId} />
      <fieldset disabled={pending || state.success} className="min-w-0 space-y-4">
        <label className="block text-sm text-text-body">
          Branch
          <select
            name="branchId"
            defaultValue={initialBranchId ?? branches[0]?.id}
            required
            className="min-h-11 w-full rounded-md border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
          >
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-text-body">
          Primary requested medicine ID (required for walk-outs)
          <Input name="medicineId" maxLength={128} className="min-h-11" />
        </label>
        <label className="block text-sm text-text-body">
          Visit outcome
          <select
            name="walkedOut"
            className="min-h-11 w-full rounded-md border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <option value="false">Served / did not walk out</option>
            <option value="true">Walked out without fulfilment</option>
          </select>
        </label>
        <Button type="submit" className="min-h-11" disabled={!branches.length}>
          {pending ? 'Recording…' : 'Record visit'}
        </Button>
      </fieldset>
      {state.message ? (
        <p role={state.success ? 'status' : 'alert'} className="text-sm text-text-body">
          {state.message}
        </p>
      ) : null}
      {state.success ? (
        <Button
          type="button"
          className="min-h-11"
          variant="outline"
          onClick={() => window.location.reload()}
        >
          Record another visit
        </Button>
      ) : null}
    </form>
  );
}
