'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

type Draft = {
  name: string;
  code: string;
  timezone: string;
  businessDayCutoff: string;
  address: string;
  shiftSignInEnforced: boolean;
};

const EMPTY: Draft = {
  name: '',
  code: '',
  timezone: 'UTC',
  businessDayCutoff: '00:00',
  address: '',
  shiftSignInEnforced: false,
};

export function RestaurantBranchesConsole() {
  const utils = trpc.useUtils();
  const query = trpc.restaurantBranches.list.useQuery();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const refresh = () => void utils.restaurantBranches.list.invalidate();
  const failure = (error: { message: string }) => toast.error(error.message);
  const create = trpc.restaurantBranches.create.useMutation({
    onSuccess: () => {
      setDraft(EMPTY);
      refresh();
      toast.success('Branch created.');
    },
    onError: failure,
  });
  const update = trpc.restaurantBranches.update.useMutation({
    onSuccess: () => {
      setEditingId(null);
      setDraft(EMPTY);
      refresh();
      toast.success('Branch updated.');
    },
    onError: failure,
  });
  const setActive = trpc.restaurantBranches.setActive.useMutation({
    onSuccess: refresh,
    onError: failure,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { ...draft, code: draft.code.toUpperCase(), address: draft.address || null };
    if (editingId) update.mutate({ id: editingId, ...input });
    else create.mutate(input);
  };
  const pending = create.isPending || update.isPending;
  const branches = query.data?.branches ?? [];
  const atLimit = branches.length >= (query.data?.limit ?? 1);

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant settings"
        heading="Branches"
        description="Manage the locations your team sees by readable name and branch code. Operational history is preserved when a branch is deactivated."
      />

      {query.error ? (
        <SectionCard title="Branch settings unavailable">
          <p role="alert" className="text-sm text-destructive">
            {query.error.data?.code === 'FORBIDDEN'
              ? 'You do not have permission to configure restaurant branches.'
              : 'Branch settings could not be loaded. Try again.'}
          </p>
        </SectionCard>
      ) : null}

      {!query.error ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.55fr)]">
          <SectionCard
            title="Locations"
            eyebrow={`${branches.length} of ${query.data?.limit ?? '—'} configured`}
          >
            {query.isLoading ? (
              <p aria-live="polite" className="text-sm text-text-muted">
                Loading branches…
              </p>
            ) : branches.length === 0 ? (
              <div className="space-y-2 py-6 text-center">
                <p className="font-medium text-text-strong">No branches configured</p>
                <p className="text-sm text-text-muted">
                  Create the first location to make it primary.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {branches.map((branch) => (
                  <li
                    key={branch.id}
                    className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-medium text-text-strong">{branch.name}</h2>
                        <span className="font-mono text-xs text-text-muted">{branch.code}</span>
                        <StatusPill status={branch.active ? 'Active' : 'Inactive'} />
                        {branch.isDefault ? <StatusPill status="Primary" tone="info" /> : null}
                      </div>
                      <p className="mt-1 text-sm text-text-muted">
                        {branch.timezone} · business day {branch.businessDayCutoff}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!branch.isDefault && branch.active ? (
                        <Button
                          variant="outline"
                          onClick={() => update.mutate({ id: branch.id, isDefault: true })}
                          disabled={update.isPending}
                        >
                          Make primary
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        onClick={() => {
                          setEditingId(branch.id);
                          setDraft({
                            name: branch.name,
                            code: branch.code,
                            timezone: branch.timezone,
                            businessDayCutoff: branch.businessDayCutoff,
                            address: branch.address ?? '',
                            shiftSignInEnforced: branch.shiftSignInEnforced,
                          });
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        disabled={setActive.isPending || (branch.active && branch.isDefault)}
                        title={
                          branch.isDefault && branch.active
                            ? 'Choose another primary branch first.'
                            : undefined
                        }
                        onClick={() => setActive.mutate({ id: branch.id, active: !branch.active })}
                      >
                        {branch.active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title={editingId ? 'Edit branch' : 'Create branch'}>
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="branch-name">Name</Label>
                <Input
                  id="branch-name"
                  value={draft.name}
                  required
                  minLength={2}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch-code">Branch code</Label>
                <Input
                  id="branch-code"
                  value={draft.code}
                  required
                  minLength={2}
                  maxLength={24}
                  placeholder="DHA-PH6"
                  className="uppercase"
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                />
                <p className="text-xs text-text-muted">
                  Stable, readable code shown in branch selectors. Letters, numbers, and hyphens
                  only.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch-timezone">Timezone</Label>
                <Input
                  id="branch-timezone"
                  value={draft.timezone}
                  required
                  onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch-cutoff">Business day cutoff</Label>
                <Input
                  id="branch-cutoff"
                  type="time"
                  value={draft.businessDayCutoff}
                  required
                  onChange={(e) => setDraft({ ...draft, businessDayCutoff: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch-address">Address</Label>
                <Input
                  id="branch-address"
                  value={draft.address}
                  onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                />
              </div>
              <label className="flex items-start gap-3 text-sm text-text-body">
                <input
                  type="checkbox"
                  checked={draft.shiftSignInEnforced}
                  onChange={(e) => setDraft({ ...draft, shiftSignInEnforced: e.target.checked })}
                  className="mt-1 size-4 accent-primary"
                />
                Require an active scheduled shift for terminal sign-in
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={pending || (!editingId && atLimit)}>
                  {pending ? 'Saving…' : editingId ? 'Save changes' : 'Create branch'}
                </Button>
                {editingId ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditingId(null);
                      setDraft(EMPTY);
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
              {!editingId && atLimit ? (
                <p role="status" className="text-sm text-warning">
                  Your current plan’s branch limit has been reached.
                </p>
              ) : null}
            </form>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
