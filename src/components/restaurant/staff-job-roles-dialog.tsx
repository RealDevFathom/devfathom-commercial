'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import { RestaurantBranchSelect } from './restaurant-branch-select';

/**
 * SOP-1 / WHA-224 — the job-role multi-select for one staff profile at one branch.
 *
 * Kept as its own component rather than woven into the staff console so the SOP-1
 * surface stays self-contained and rebases cleanly onto the M9 union.
 *
 * BRANCH SCOPE IS EXPLICIT, NOT IMPLIED. Holdings are per branch, so the dialog
 * makes the operator choose one and shows only that branch's roles. Saving sends
 * the complete desired set for THAT branch — the server diffs it — so a save here
 * can never disturb the same person's roles elsewhere. The branch defaults to the
 * profile's primary branch when it has one, because that is the overwhelmingly
 * common case, but it stays editable.
 *
 * The save is immediately effective (nothing caches capabilities) and appended to
 * the DB-enforced append-only audit, which is shown beneath the picker so the
 * consequence of the edit is visible in the same place it is made.
 */

export type StaffJobRolesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staffProfileId: string;
  staffDisplayName: string;
  /** Pre-selects the branch; the operator can still change it. */
  defaultBranchId?: string | null;
};

const auditDateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function StaffJobRolesDialog({
  open,
  onOpenChange,
  staffProfileId,
  staffDisplayName,
  defaultBranchId,
}: StaffJobRolesDialogProps) {
  const utils = trpc.useUtils();
  const [branchId, setBranchId] = useState(defaultBranchId ?? '');
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, { enabled: open });
  /**
   * `null` means PRISTINE — the operator has not touched the checkboxes, so the
   * server's answer is the truth and a background refetch should show through.
   * Once they edit, this holds their draft and server updates stop overwriting it.
   *
   * Deriving the displayed set this way (rather than mirroring the query into
   * state with an effect) means there is no sync step to get wrong: no cascading
   * render, no refetch silently discarding an edit, and nothing to reset on close
   * — the parent unmounts this component, so a fresh open starts pristine.
   */
  const [draft, setDraft] = useState<Set<string> | null>(null);

  const rolesQuery = trpc.restaurantStaff.listJobRoles.useQuery(
    { activeOnly: true },
    { enabled: open }
  );
  const holdingsQuery = trpc.restaurantStaff.listStaffJobRoles.useQuery(
    { staffProfileId, branchId },
    { enabled: open && branchId.length > 0 }
  );
  const auditQuery = trpc.restaurantStaff.listStaffJobRoleAudit.useQuery(
    { staffProfileId, branchId, take: 20 },
    { enabled: open && branchId.length > 0 }
  );

  const heldRoleIds = (holdingsQuery.data ?? []).map((holding) => holding.jobRole.id);
  const selected = draft ?? new Set(heldRoleIds);
  const dirty = draft !== null;

  const save = trpc.restaurantStaff.setStaffJobRoles.useMutation({
    onSuccess: (result) => {
      // Back to pristine: the server is authoritative again.
      setDraft(null);
      void utils.restaurantStaff.listStaffJobRoles.invalidate({ staffProfileId, branchId });
      void utils.restaurantStaff.listStaffJobRoleAudit.invalidate({ staffProfileId, branchId });
      const changes = result.granted.length + result.revoked.length;
      toast.success(
        changes === 0
          ? 'No job-role changes to apply.'
          : `Job roles updated — ${result.granted.length} added, ${result.revoked.length} removed.`
      );
    },
    onError: (error) => toast.error(error.message),
  });

  const toggle = (jobRoleId: string) => {
    setDraft((current) => {
      const next = new Set(current ?? heldRoleIds);
      if (next.has(jobRoleId)) next.delete(jobRoleId);
      else next.add(jobRoleId);
      return next;
    });
  };

  const roles = rolesQuery.data ?? [];
  const branchChosen = branchId.trim().length > 0;
  const loading = rolesQuery.isLoading || (branchChosen && holdingsQuery.isLoading);
  const pending = save.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{staffDisplayName} — job roles</DialogTitle>
          <DialogDescription>
            A person can hold any number of roles. Their permissions and the SOP pools they can
            claim from are the union of every role held here, plus any direct grants.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="space-y-1.5 block">
            <span className="text-sm font-medium text-text-strong">Branch</span>
            <RestaurantBranchSelect
              branches={branchesQuery.data ?? []}
              loading={branchesQuery.isLoading}
              error={Boolean(branchesQuery.error)}
              value={branchId}
              onChange={(value) => {
                setBranchId(value);
                // The draft was for the previous branch; discard it rather than
                // carrying a stale selection across branches.
                setDraft(null);
              }}
              disabled={pending}
            />
            <span id="job-roles-branch-help" className="block text-xs text-text-faint">
              Roles are held per branch. Saving changes this branch only.
            </span>
          </label>

          {!branchChosen ? (
            <p className="rounded-md border border-dashed border-border-subtle px-3 py-6 text-center text-sm text-text-muted">
              Select a branch to view and edit roles.
            </p>
          ) : loading ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : roles.length === 0 ? (
            <p className="rounded-md border border-dashed border-border-subtle px-3 py-6 text-center text-sm text-text-muted">
              No active job roles exist yet. Create one before assigning it.
            </p>
          ) : (
            <fieldset className="space-y-2" disabled={pending}>
              <legend className="sr-only">Job roles held at this branch</legend>
              {roles.map((role) => {
                const checked = selected.has(role.id);
                return (
                  <label
                    key={role.id}
                    className="flex cursor-pointer items-start gap-3 rounded-md border border-border-subtle px-3 py-2.5 transition-colors hover:bg-surface-muted focus-within:ring-2 focus-within:ring-ring"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-[var(--color-accent)]"
                      checked={checked}
                      onChange={() => toggle(role.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-text-strong">{role.name}</span>
                        <span className="font-mono text-xs text-text-faint">{role.key}</span>
                        {role.isSystem ? <StatusPill status="BUILT-IN" tone="neutral" /> : null}
                      </span>
                      {role.description ? (
                        <span className="mt-0.5 block text-xs text-text-muted">
                          {role.description}
                        </span>
                      ) : null}
                      {role.capabilities.length ? (
                        <span className="mt-1 block font-mono text-[11px] text-text-faint">
                          {role.capabilities.map((entry) => entry.capability).join(' · ')}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}

          {branchChosen && (auditQuery.data?.length ?? 0) > 0 ? (
            <section className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-faint">
                Recent role changes
              </h3>
              <ul className="space-y-1">
                {(auditQuery.data ?? []).map((entry) => (
                  <li key={entry.id} className="flex items-baseline gap-2 text-xs text-text-muted">
                    <span
                      className={
                        entry.change === 'GRANTED' ? 'text-success-strong' : 'text-text-faint'
                      }
                    >
                      {entry.change === 'GRANTED' ? 'Added' : 'Removed'}
                    </span>
                    <span className="font-mono">{entry.jobRoleKey}</span>
                    <span className="ml-auto tabular-nums">
                      {auditDateFormat.format(new Date(entry.createdAt))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Close
          </Button>
          <Button
            onClick={() => save.mutate({ staffProfileId, branchId, jobRoleIds: [...selected] })}
            disabled={!branchChosen || pending || !dirty}
          >
            {pending ? 'Saving…' : 'Save roles'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
