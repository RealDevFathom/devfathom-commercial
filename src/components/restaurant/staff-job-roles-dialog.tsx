'use client';

import { useMemo, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { RESTAURANT_CAPABILITIES } from '@/lib/vertical-catalog';
import { trpc } from '@/lib/trpc';
import { RestaurantBranchSelect } from './restaurant-branch-select';

export type StaffJobRolesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staffProfileId: string;
  staffDisplayName: string;
  defaultBranchId?: string | null;
  defaultBranchName?: string | null;
};
type Effect = 'ALLOW' | 'DENY';
const tones = { inherited: 'neutral', direct: 'success', denied: 'warning' } as const;

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
  const [search, setSearch] = useState('');
  const [saveError, setSaveError] = useState('');
  const rolesQuery = trpc.restaurantStaff.listJobRoles.useQuery(
    { activeOnly: true },
    { enabled: open }
  );
  const holdingsQuery = trpc.restaurantStaff.listStaffJobRoles.useQuery(
    { staffProfileId, branchId },
    { enabled: open && !!branchId }
  );
  const accessQuery = trpc.restaurantStaff.resolveStaffCapabilities.useQuery(
    { staffProfileId, branchId },
    { enabled: open && !!branchId }
  );
  const held = (holdingsQuery.data ?? []).map((item) => item.jobRole.id);
  const selected = draft ?? new Set(held);
  const inherited = new Set(
    (rolesQuery.data ?? [])
      .filter((role) => selected.has(role.id))
      .flatMap((role) => role.capabilities.map((item) => item.capability))
  );
  const direct = new Set(accessQuery.data?.allowed ?? []);
  const denied = new Set(accessQuery.data?.denied ?? []);
  const visible = useMemo(
    () => RESTAURANT_CAPABILITIES.filter((item) => item.includes(search.trim().toLowerCase())),
    [search]
  );
  const refresh = () =>
    void utils.restaurantStaff.resolveStaffCapabilities.invalidate({ staffProfileId, branchId });
  const save = trpc.restaurantStaff.setStaffJobRoles.useMutation({
    onSuccess: (result) => {
      setDraft(null);
      setSaveError('');
      void utils.restaurantStaff.listStaffJobRoles.invalidate({ staffProfileId, branchId });
      refresh();
      toast.success(
        `Access updated — ${result.granted.length} added, ${result.revoked.length} removed.`
      );
    },
    onError: (error) => {
      setSaveError(`${error.message} Your selections are still here; try saving again.`);
      toast.error(error.message);
    },
  });
  const setOverride = trpc.restaurantStaff.setStaffCapabilityOverride.useMutation({
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const clearOverride = trpc.restaurantStaff.clearStaffCapabilityOverride.useMutation({
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const pending = save.isPending || setOverride.isPending || clearOverride.isPending;
  const loading = rolesQuery.isLoading || holdingsQuery.isLoading || accessQuery.isLoading;
  const loadError = rolesQuery.error || holdingsQuery.error || accessQuery.error;
  const toggleRole = (id: string) =>
    setDraft((current) => {
      const next = new Set(current ?? held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const choose = (capability: string, effect: Effect | null) =>
    effect
      ? setOverride.mutate({ staffProfileId, branchId, capability, effect })
      : clearOverride.mutate({ staffProfileId, branchId, capability });

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        aria-modal="true"
        overlayClassName="bg-surface-page supports-backdrop-filter:backdrop-blur-none"
        className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>{staffDisplayName} — role profile</DialogTitle>
          <DialogDescription>
            Roles combine for this person. Add a direct capability for an exception, or deny an
            inherited capability without changing the role for anyone else.
          </DialogDescription>
        </DialogHeader>
        <div
          data-testid="role-dialog-scroll-region"
          className="min-h-0 space-y-4 overflow-y-auto px-0.5"
        >
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
                setSaveError('');
              }}
              disabled={pending}
            />
            <span id="job-roles-branch-help" className="block text-xs text-text-faint">
              Roles are held per branch. Saving changes this branch only.
            </span>
          </label>

          {!branchId ? (
            <p className="rounded-md border border-dashed border-border-subtle px-3 py-6 text-center text-sm text-text-muted">
              Select a branch to view and edit roles.
            </p>
          ) : loading ? (
            <div role="status" aria-label="Loading role profile" className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-40 w-full" />
              <span className="sr-only">Loading roles and capabilities…</span>
            </div>
          ) : loadError ? (
            <div role="alert" className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
              Access details could not be loaded. Close this panel and try again; no changes were
              made.
            </div>
          ) : (
            <div className="space-y-6">
              <section aria-labelledby="profile-roles" className="space-y-3">
                <div>
                  <h3 id="profile-roles" className="font-semibold text-text-strong">
                    Role profiles
                  </h3>
                  <p className="text-sm text-text-muted">
                    Select any number. Capability previews update before you save.
                  </p>
                </div>
                {(rolesQuery.data ?? []).length === 0 ? (
                  <p className="rounded-md border border-dashed border-border-default p-4 text-sm text-text-muted">
                    No active role profiles exist. Create or activate a role, then return here.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(rolesQuery.data ?? []).map((role) => {
                      const active = selected.has(role.id);
                      return (
                        <Button
                          key={role.id}
                          type="button"
                          variant={active ? 'secondary' : 'outline'}
                          aria-pressed={active}
                          disabled={pending}
                          onClick={() => toggleRole(role.id)}
                          className="h-auto min-h-14 justify-start whitespace-normal px-3 py-2 text-left"
                        >
                          <span>
                            <span className="block font-medium">{role.name}</span>
                            <span className="block text-xs font-normal text-text-strong">
                              {role.capabilities.length} inherited capabilities
                            </span>
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                )}
                {saveError ? (
                  <p
                    role="alert"
                    className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                  >
                    {saveError}
                  </p>
                ) : null}
              </section>
              <section aria-labelledby="profile-capabilities" className="space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 id="profile-capabilities" className="font-semibold text-text-strong">
                      Capabilities
                    </h3>
                    <p className="text-sm text-text-muted">
                      Each row shows why access is available or withheld.
                    </p>
                  </div>
                  <label className="w-full sm:w-64">
                    <span className="sr-only">Search capabilities</span>
                    <Input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search capabilities"
                      className="h-11"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2" aria-label="Capability provenance legend">
                  <StatusPill
                    status="Inherited from role"
                    tone="neutral"
                    className="!text-text-strong"
                  />
                  <StatusPill status="Direct exception" tone="success" />
                  <StatusPill
                    status="Denied for person"
                    tone="warning"
                    className="!text-text-strong"
                  />
                </div>
                {visible.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border-default p-4 text-sm text-text-muted">
                    No capabilities match. Clear the search to see the full list; your selections
                    are preserved.
                  </p>
                ) : (
                  <div className="divide-y divide-border-subtle rounded-md border border-border-default">
                    {visible.map((capability) => {
                      const isDenied = denied.has(capability),
                        isDirect = direct.has(capability),
                        isInherited = inherited.has(capability);
                      const state = isDenied
                        ? 'denied'
                        : isDirect
                          ? 'direct'
                          : isInherited
                            ? 'inherited'
                            : null;
                      return (
                        <div
                          key={capability}
                          className="flex min-h-14 flex-wrap items-center gap-3 px-3 py-2 hover:bg-surface-muted"
                        >
                          <span className="min-w-0 flex-1 font-mono text-xs text-text-strong">
                            {capability}
                          </span>
                          {state ? (
                            <StatusPill
                              status={
                                state === 'inherited'
                                  ? 'Inherited'
                                  : state === 'direct'
                                    ? 'Direct'
                                    : 'Denied'
                              }
                              tone={tones[state]}
                              className={state === 'direct' ? undefined : '!text-text-strong'}
                            />
                          ) : (
                            <span className="text-xs text-text-strong">Not granted</span>
                          )}
                          <div
                            className="flex gap-1"
                            role="group"
                            aria-label={`Access for ${capability}`}
                          >
                            <Button
                              type="button"
                              size="sm"
                              variant={isDirect ? 'secondary' : 'ghost'}
                              aria-pressed={isDirect}
                              disabled={pending}
                              onClick={() => choose(capability, isDirect ? null : 'ALLOW')}
                            >
                              Direct
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={isDenied ? 'secondary' : 'ghost'}
                              aria-pressed={isDenied}
                              disabled={pending}
                              onClick={() => choose(capability, isDenied ? null : 'DENY')}
                            >
                              Deny
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Close
          </Button>
          <Button
            onClick={() => save.mutate({ staffProfileId, branchId, jobRoleIds: [...selected] })}
            disabled={!branchId || pending || draft === null || !!loadError}
          >
            {save.isPending ? 'Saving…' : 'Save role profiles'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
