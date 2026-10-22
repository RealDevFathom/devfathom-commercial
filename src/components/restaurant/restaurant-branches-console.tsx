'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

type FieldName = keyof Pick<Draft, 'name' | 'code' | 'timezone' | 'businessDayCutoff' | 'address'>;
type FieldErrors = Partial<Record<FieldName, string>>;
type MutationError = {
  message: string;
  data?: { validation?: Partial<Record<FieldName, string[]>> | null };
};

const EMPTY: Draft = {
  name: '',
  code: '',
  timezone: 'UTC',
  businessDayCutoff: '00:00',
  address: '',
  shiftSignInEnforced: false,
};

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

export function RestaurantBranchesConsole() {
  const utils = trpc.useUtils();
  const query = trpc.restaurantBranches.list.useQuery();
  const branches = query.data?.branches ?? [];
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [deactivating, setDeactivating] = useState<(typeof branches)[number] | null>(null);
  const refresh = () => void utils.restaurantBranches.list.invalidate();
  const failure = (error: { message: string }) => toast.error(error.message);
  const formFailure = (error: MutationError) => {
    const validation = error.data?.validation;
    const next: FieldErrors = {};
    if (validation) {
      for (const field of Object.keys(validation) as FieldName[]) {
        const message = validation[field]?.[0];
        if (message) next[field] = message;
      }
    }
    if (error.message.includes('with this name')) next.name = error.message;
    if (error.message.includes('with this code')) next.code = error.message;
    if (error.message.startsWith('Timezone and business-day cutoff')) {
      next.timezone = error.message;
      next.businessDayCutoff = error.message;
    }
    setFieldErrors(next);
    const first = (
      ['name', 'code', 'timezone', 'businessDayCutoff', 'address'] as FieldName[]
    ).find((field) => next[field]);
    const fieldIds: Record<FieldName, string> = {
      name: 'branch-name',
      code: 'branch-code',
      timezone: 'branch-timezone',
      businessDayCutoff: 'branch-cutoff',
      address: 'branch-address',
    };
    if (first) requestAnimationFrame(() => document.getElementById(fieldIds[first])?.focus());
    toast.error(error.message);
  };
  const create = trpc.restaurantBranches.create.useMutation({
    onSuccess: () => {
      setDraft(EMPTY);
      refresh();
      toast.success('Branch created.');
    },
    onError: formFailure,
  });
  const update = trpc.restaurantBranches.update.useMutation({
    onSuccess: () => {
      setEditingId(null);
      setDraft(EMPTY);
      refresh();
      toast.success('Branch updated.');
    },
    onError: formFailure,
  });
  const setActive = trpc.restaurantBranches.setActive.useMutation({
    onSuccess: (_branch, variables) => {
      setDeactivating(null);
      refresh();
      toast.success(variables.active ? 'Branch activated.' : 'Branch deactivated.');
    },
    onError: failure,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    const editable = {
      name: draft.name,
      timezone: draft.timezone,
      businessDayCutoff: draft.businessDayCutoff,
      address: draft.address || null,
      shiftSignInEnforced: draft.shiftSignInEnforced,
    };
    if (editingId) update.mutate({ id: editingId, ...editable });
    else create.mutate({ ...editable, code: draft.code.toUpperCase() });
  };
  const pending = create.isPending || update.isPending;
  const activeCount = branches.filter((branch) => branch.active).length;
  const atLimit = activeCount >= (query.data?.limit ?? 1);

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
            eyebrow={`${activeCount} of ${query.data?.limit ?? '—'} active`}
            titleLevel={2}
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
                        variant={branch.active ? 'destructive' : 'outline'}
                        disabled={setActive.isPending || (branch.active && branch.isDefault)}
                        title={
                          branch.isDefault && branch.active
                            ? 'Choose another primary branch first.'
                            : undefined
                        }
                        onClick={() => {
                          if (branch.active) setDeactivating(branch);
                          else setActive.mutate({ id: branch.id, active: true });
                        }}
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
                  maxLength={120}
                  aria-invalid={Boolean(fieldErrors.name)}
                  aria-describedby={fieldErrors.name ? 'branch-name-error' : undefined}
                  onChange={(e) => {
                    setDraft({ ...draft, name: e.target.value });
                    setFieldErrors({ ...fieldErrors, name: undefined });
                  }}
                />
                <FieldError id="branch-name-error" message={fieldErrors.name} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch-code">Branch code</Label>
                <Input
                  id="branch-code"
                  value={draft.code}
                  required
                  minLength={2}
                  maxLength={24}
                  pattern="[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*"
                  placeholder="DHA-PH6"
                  className="uppercase"
                  disabled={editingId !== null}
                  aria-invalid={Boolean(fieldErrors.code)}
                  aria-describedby={fieldErrors.code ? 'branch-code-error' : undefined}
                  onChange={(e) => {
                    setDraft({ ...draft, code: e.target.value });
                    setFieldErrors({ ...fieldErrors, code: undefined });
                  }}
                />
                <FieldError id="branch-code-error" message={fieldErrors.code} />
                <p className="text-xs text-text-muted">
                  {editingId
                    ? 'Branch codes are permanent so operational references remain stable.'
                    : 'Stable, readable code shown in branch selectors. Letters, numbers, and hyphens only.'}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch-timezone">Timezone</Label>
                <Input
                  id="branch-timezone"
                  value={draft.timezone}
                  required
                  aria-invalid={Boolean(fieldErrors.timezone)}
                  aria-describedby={fieldErrors.timezone ? 'branch-timezone-error' : undefined}
                  onChange={(e) => {
                    setDraft({ ...draft, timezone: e.target.value });
                    setFieldErrors({ ...fieldErrors, timezone: undefined });
                  }}
                />
                <FieldError id="branch-timezone-error" message={fieldErrors.timezone} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch-cutoff">Business day cutoff</Label>
                <Input
                  id="branch-cutoff"
                  type="time"
                  value={draft.businessDayCutoff}
                  required
                  aria-invalid={Boolean(fieldErrors.businessDayCutoff)}
                  aria-describedby={
                    fieldErrors.businessDayCutoff ? 'branch-cutoff-error' : undefined
                  }
                  onChange={(e) => {
                    setDraft({ ...draft, businessDayCutoff: e.target.value });
                    setFieldErrors({ ...fieldErrors, businessDayCutoff: undefined });
                  }}
                />
                <FieldError id="branch-cutoff-error" message={fieldErrors.businessDayCutoff} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch-address">Address</Label>
                <Input
                  id="branch-address"
                  value={draft.address}
                  maxLength={300}
                  aria-invalid={Boolean(fieldErrors.address)}
                  aria-describedby={fieldErrors.address ? 'branch-address-error' : undefined}
                  onChange={(e) => {
                    setDraft({ ...draft, address: e.target.value });
                    setFieldErrors({ ...fieldErrors, address: undefined });
                  }}
                />
                <FieldError id="branch-address-error" message={fieldErrors.address} />
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

      <Dialog
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open && !setActive.isPending) setDeactivating(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Deactivate {deactivating?.name}?</DialogTitle>
            <DialogDescription>
              Terminals at this branch will lose access immediately. New operational work will be
              blocked, while existing history remains available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={setActive.isPending}
              onClick={() => setDeactivating(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={setActive.isPending}
              onClick={() => {
                if (deactivating) setActive.mutate({ id: deactivating.id, active: false });
              }}
            >
              {setActive.isPending ? 'Deactivating…' : 'Deactivate branch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
