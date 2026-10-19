'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
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
/** What an operator has staged for one capability. `null` = clear the override. */
type PendingEffect = Effect | null;
const tones = { inherited: 'neutral', direct: 'success', denied: 'warning' } as const;

/**
 * WHA-1181 items 6–8 — this dialog commits ONCE.
 *
 * WHAT CHANGED AND WHY. Every Direct/Deny click used to fire its own mutation:
 * the row could not change until the server answered, and "Save role profiles"
 * covered the role checkboxes only — so in an organization with no role profiles
 * the one visible commit button was permanently disabled while the operator was
 * making real changes through a different, slower path.
 *
 * The model is now: the server's answer is the BASE, and `pendingRoles` /
 * `pendingOverrides` are the operator's staged intent on top of it. Everything
 * rendered reads the overlay, so a click repaints on the next frame with no
 * request in flight. One mutation commits both halves (`setStaffAccess`), and
 * failure restores the base by simply keeping the staged intent — nothing was
 * written, so there is nothing to undo — and pins the error to the affected rows.
 *
 * NOTHING IS DISABLED WHILE SAVING. Disabling the rows mid-flight would
 * reintroduce exactly the lag this removes; the commit button shows the pending
 * state instead. A synchronous latch blocks duplicate submissions and a snapshot
 * clears only submitted edits, preserving changes made while the request runs.
 *
 * NO NEW STATE LIBRARY: two `useState` values and a derived overlay.
 */
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
   * `null` means PRISTINE — the operator has not touched the role checkboxes, so
   * the server's answer is the truth and a background refetch shows through.
   * Once they edit, this holds their draft and server updates stop overwriting
   * it. Deriving the displayed set this way (rather than mirroring the query into
   * state with an effect) means there is no sync step to get wrong.
   */
  const [pendingRoles, setPendingRoles] = useState<Set<string> | null>(null);
  /** Only the capabilities the operator actually touched, staged over the base. */
  const [pendingOverrides, setPendingOverrides] = useState<Map<string, PendingEffect>>(new Map());
  const [search, setSearch] = useState('');
  const [saveError, setSaveError] = useState('');
  const [confirmingGrantAll, setConfirmingGrantAll] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

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

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const held = useMemo(
    () => (holdingsQuery.data ?? []).map((item) => item.jobRole.id),
    [holdingsQuery.data]
  );
  // Memoised so the `inherited` preview below is not recomputed on every render
  // by a freshly-allocated Set that is equal to the one it replaced.
  const selected = useMemo(() => pendingRoles ?? new Set(held), [pendingRoles, held]);
  const inherited = useMemo(
    () =>
      new Set(
        roles
          .filter((role) => selected.has(role.id))
          .flatMap((role) => role.capabilities.map((item) => item.capability))
      ),
    [roles, selected]
  );

  // The server's committed overrides — the base the staged map sits on top of.
  const baseAllowed = useMemo(() => new Set(accessQuery.data?.allowed ?? []), [accessQuery.data]);
  const baseDenied = useMemo(() => new Set(accessQuery.data?.denied ?? []), [accessQuery.data]);
  const effectFor = (capability: string): PendingEffect => {
    if (pendingOverrides.has(capability)) return pendingOverrides.get(capability) ?? null;
    if (baseDenied.has(capability)) return 'DENY';
    if (baseAllowed.has(capability)) return 'ALLOW';
    return null;
  };

  const visible = useMemo(
    () => RESTAURANT_CAPABILITIES.filter((item) => item.includes(search.trim().toLowerCase())),
    [search]
  );

  const rolesDirty = pendingRoles !== null && !sameSet(pendingRoles, new Set(held));
  // A staged entry equal to the committed value is not a change. Re-clicking
  // Direct twice returns the row to where it started and must not inflate the
  // count — otherwise "Save 6 changes" would count work that does not exist.
  const overrideChanges = useMemo(
    () =>
      [...pendingOverrides.entries()]
        .filter(([capability, effect]) => effect !== committed(capability, baseAllowed, baseDenied))
        .map(([capability, effect]) => ({ capability, effect })),
    [pendingOverrides, baseAllowed, baseDenied]
  );
  const pendingCount = (rolesDirty ? 1 : 0) + overrideChanges.length;

  const seedRoles = trpc.restaurantStaff.seedDefaultJobRoles.useMutation({
    onSuccess: (result) => {
      void utils.restaurantStaff.listJobRoles.invalidate();
      toast.success(`${result.created.length} role profile(s) added.`);
    },
    onError: (error) => toast.error(error.message),
  });

  const currentScope = useRef({ staffProfileId, branchId });
  useLayoutEffect(() => {
    currentScope.current = { staffProfileId, branchId };
  }, [staffProfileId, branchId]);
  const submitted = useRef<{
    staffProfileId: string;
    branchId: string;
    roles: Set<string> | null;
    overrides: Map<string, PendingEffect>;
  } | null>(null);
  const isCurrentScope = (snapshot: NonNullable<typeof submitted.current>) =>
    snapshot.staffProfileId === currentScope.current.staffProfileId &&
    snapshot.branchId === currentScope.current.branchId;

  const save = trpc.restaurantStaff.setStaffAccess.useMutation({
    onSuccess: (result) => {
      const snapshot = submitted.current;
      submitted.current = null;
      if (!snapshot) return;
      const variables = { staffProfileId: snapshot.staffProfileId, branchId: snapshot.branchId };
      void utils.restaurantStaff.listStaffJobRoles.invalidate(variables);
      void utils.restaurantStaff.resolveStaffCapabilities.invalidate(variables);
      if (!isCurrentScope(snapshot)) return;
      setPendingRoles((current) => (current === snapshot.roles ? null : current));
      setPendingOverrides((current) => {
        const remaining = new Map(current);
        for (const [capability, effect] of snapshot.overrides) {
          if (remaining.get(capability) === effect) remaining.delete(capability);
        }
        return remaining;
      });
      setSaveError('');
      toast.success(
        `Access updated — ${result?.granted.length ?? 0} role(s) added, ${result?.revoked.length ?? 0} removed, ${result?.overrides.length ?? 0} capability change(s).`
      );
    },
    onError: (error) => {
      const snapshot = submitted.current;
      submitted.current = null;
      if (!snapshot || !isCurrentScope(snapshot)) return;
      // Nothing was written, so the base is still the truth and the staged
      // intent is still the operator's. Keeping both IS the rollback: the rows
      // fall back to the server state they never actually left.
      setSaveError(`${error.message} Nothing was saved; your changes are still here.`);
      toast.error(error.message);
    },
  });

  const loading = rolesQuery.isLoading || holdingsQuery.isLoading || accessQuery.isLoading;
  const loadError = rolesQuery.error || holdingsQuery.error || accessQuery.error;

  const toggleRole = (id: string) =>
    setPendingRoles((current) => {
      const next = new Set(current ?? held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const stage = (capability: string, effect: PendingEffect) =>
    setPendingOverrides((current) => new Map(current).set(capability, effect));

  const stageAllDirect = () =>
    setPendingOverrides((current) => {
      const next = new Map(current);
      // Deliberately every capability in the catalog, not just the filtered
      // rows: the action says "grant all", and silently honouring an unrelated
      // search box would grant a different set than the label promises.
      for (const capability of RESTAURANT_CAPABILITIES) next.set(capability, 'ALLOW');
      return next;
    });

  const stageClearDirect = () =>
    setPendingOverrides((current) => {
      const next = new Map(current);
      for (const capability of RESTAURANT_CAPABILITIES) {
        if (baseAllowed.has(capability) || next.get(capability) === 'ALLOW') {
          // Only ALLOW overrides are cleared. A DENY is the subtractive layer an
          // operator set on purpose; "Clear direct exceptions" must not quietly
          // re-grant something that was deliberately taken away.
          next.set(capability, null);
        }
      }
      return next;
    });

  const discard = () => {
    setPendingRoles(null);
    setPendingOverrides(new Map());
    setSaveError('');
    setConfirmingDiscard(false);
    onOpenChange(false);
  };

  const requestClose = () => {
    if (pendingCount > 0) setConfirmingDiscard(true);
    else discard();
  };

  const commit = () => {
    if (submitted.current) return;
    submitted.current = {
      staffProfileId,
      branchId,
      roles: pendingRoles,
      overrides: new Map(pendingOverrides),
    };
    save.mutate({
      staffProfileId,
      branchId,
      jobRoleIds: [...selected],
      overrides: overrideChanges,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent
        aria-modal="true"
        overlayClassName="bg-surface-page supports-backdrop-filter:backdrop-blur-none"
        className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>{staffDisplayName} — role profile</DialogTitle>
          <DialogDescription>
            Roles combine for this person. Add a direct capability for an exception, or deny an
            inherited capability without changing the role for anyone else. Changes apply when you
            save.
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
                setPendingRoles(null);
                setPendingOverrides(new Map());
                setSaveError('');
              }}
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
                {roles.length === 0 ? (
                  /**
                   * The old copy said "Create or activate a role, then return
                   * here" and pointed at nothing: there is no roles management
                   * page in this build, which is why an organization that
                   * missed the seed had no way out except granting every
                   * capability one at a time as a direct exception. The seed is
                   * offered inline instead — the same idempotent
                   * `ensureDefaultJobRoles` activation now runs — so roles stay
                   * the primary path rather than a dead end.
                   */
                  <div className="space-y-3 rounded-md border border-dashed border-border-default p-4">
                    <p className="text-sm text-text-muted">
                      No active role profiles exist. A role covers a whole job and stays correct for
                      everyone who holds it — prefer one over per-person exceptions.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => seedRoles.mutate()}
                      disabled={seedRoles.isPending}
                    >
                      {seedRoles.isPending ? 'Adding roles…' : 'Add the default role profiles'}
                    </Button>
                    {seedRoles.error ? (
                      <p role="alert" className="text-sm text-destructive">
                        {seedRoles.error.message}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {roles.map((role) => {
                      const active = selected.has(role.id);
                      return (
                        <Button
                          key={role.id}
                          type="button"
                          variant={active ? 'secondary' : 'outline'}
                          aria-pressed={active}
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
                <div className="flex flex-wrap items-center gap-2">
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
                  <span className="ms-auto flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmingGrantAll(true)}
                    >
                      Grant all as direct exceptions
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={stageClearDirect}>
                      Clear direct exceptions
                    </Button>
                  </span>
                </div>
                {confirmingGrantAll ? (
                  <div
                    role="alertdialog"
                    aria-label="Confirm granting every capability directly"
                    className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-text-body"
                  >
                    <p>
                      Grant all {RESTAURANT_CAPABILITIES.length} capabilities to {staffDisplayName}{' '}
                      as direct exceptions? Direct exceptions belong to this person alone — a role
                      profile is the better tool when the whole job needs the access.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          stageAllDirect();
                          setConfirmingGrantAll(false);
                        }}
                      >
                        Grant all as direct
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmingGrantAll(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
                {visible.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border-default p-4 text-sm text-text-muted">
                    No capabilities match. Clear the search to see the full list; your selections
                    are preserved.
                  </p>
                ) : (
                  <div className="divide-y divide-border-subtle rounded-md border border-border-default">
                    {visible.map((capability) => {
                      const effect = effectFor(capability);
                      const isDirect = effect === 'ALLOW';
                      const isDenied = effect === 'DENY';
                      const isInherited = inherited.has(capability);
                      const state = isDenied
                        ? 'denied'
                        : isDirect
                          ? 'direct'
                          : isInherited
                            ? 'inherited'
                            : null;
                      const staged = overrideChanges.some(
                        (change) => change.capability === capability
                      );
                      return (
                        <div
                          key={capability}
                          data-testid={`capability-row-${capability}`}
                          data-pending={staged ? 'true' : undefined}
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
                          {staged ? (
                            <span className="text-xs font-medium text-text-muted">Unsaved</span>
                          ) : null}
                          {saveError && staged ? (
                            <span role="alert" className="w-full text-xs text-destructive">
                              Not saved — this change is still pending.
                            </span>
                          ) : null}
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
                              onClick={() => stage(capability, isDirect ? null : 'ALLOW')}
                            >
                              Direct
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={isDenied ? 'secondary' : 'ghost'}
                              aria-pressed={isDenied}
                              onClick={() => stage(capability, isDenied ? null : 'DENY')}
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
        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {confirmingDiscard ? (
            <div
              role="alertdialog"
              aria-label="Discard unsaved changes"
              className="flex w-full flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-text-body"
            >
              <span className="flex-1">
                Discard {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'}?
              </span>
              <Button type="button" size="sm" variant="outline" onClick={discard}>
                Discard
              </Button>
              <Button type="button" size="sm" onClick={() => setConfirmingDiscard(false)}>
                Keep editing
              </Button>
            </div>
          ) : (
            <>
              <Button variant="outline" onClick={requestClose}>
                Close
              </Button>
              <Button onClick={commit} disabled={!branchId || pendingCount === 0 || !!loadError}>
                {save.isPending
                  ? 'Saving…'
                  : pendingCount === 0
                    ? 'Save role profiles'
                    : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function committed(capability: string, allowed: Set<string>, denied: Set<string>): PendingEffect {
  if (denied.has(capability)) return 'DENY';
  if (allowed.has(capability)) return 'ALLOW';
  return null;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
