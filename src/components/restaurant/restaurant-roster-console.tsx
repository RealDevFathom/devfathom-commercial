'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
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
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

/**
 * Completion wave — the branch shift roster console.
 *
 * Deliberately built from the same grammar as the staff console it sits beside
 * (`restaurant-staff-console.tsx`): PageHeader → filter row → bounded table →
 * dialogs for the write paths, Studio semantic tokens throughout, no new visual
 * vocabulary. Branch selection reuses the plain branch-id field the insights and
 * money consoles already use, because the tenant API exposes no branch list
 * procedure; the operator picker, by contrast, reads real staff profiles so a
 * manager never types a raw profile id.
 *
 * Instants are entered with `datetime-local`, i.e. in the manager's own device
 * time zone, and the SERVER stamps the branch's operating day from the branch
 * timezone and cutoff — the helper text says so rather than letting the manager
 * assume the roster is branch-local.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Shift = RouterOutputs['restaurantShifts']['list'][number];
type StaffProfile = RouterOutputs['restaurantStaff']['list'][number];
type UiError = { message: string; data?: { code?: string } | null };

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';
const dayFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat('en', { timeStyle: 'short' });

function isPermissionError(error?: UiError | null) {
  return error?.data?.code === 'FORBIDDEN' || error?.data?.code === 'UNAUTHORIZED';
}

function formText(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

/** `YYYY-MM-DD` for a date offset from today, in the viewer's own calendar. */
function isoDay(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

/** A `Date` rendered as the `datetime-local` value for the viewer's time zone. */
function toLocalInputValue(value: Date | string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function RosterSkeleton() {
  return (
    <div role="status" aria-label="Loading roster" className="space-y-3 py-2">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-12 w-full motion-reduce:animate-none" />
      ))}
    </div>
  );
}

export function RestaurantRosterConsole() {
  const entitlements = useEntitlements();
  const restaurantModule = entitlements.modules.find((module) => module.key === 'restaurant-core');
  const restaurantEnabled =
    restaurantModule?.enabled ?? entitlements.enabledModules.includes('restaurant-core');
  const utils = trpc.useUtils();

  const [branchId, setBranchId] = useState('');
  const [fromDate, setFromDate] = useState(() => isoDay(0));
  const [toDate, setToDate] = useState(() => isoDay(6));
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [cancelling, setCancelling] = useState<Shift | null>(null);

  const normalizedBranchId = branchId.trim();
  const branchReady = restaurantEnabled && normalizedBranchId.length > 0;
  const rosterInput = {
    branchId: normalizedBranchId,
    fromBusinessDate: fromDate,
    toBusinessDate: toDate,
    includeCancelled,
  };

  const rosterQuery = trpc.restaurantShifts.list.useQuery(rosterInput, { enabled: branchReady });
  const staffQuery = trpc.restaurantStaff.list.useQuery(
    { branchId: normalizedBranchId, status: 'ACTIVE' },
    { enabled: branchReady }
  );

  const refreshRoster = () => void utils.restaurantShifts.list.invalidate(rosterInput);
  const mutationFailure = (error: { message: string }) => toast.error(error.message);

  const createShift = trpc.restaurantShifts.create.useMutation({
    onSuccess: () => {
      refreshRoster();
      setFormOpen(false);
      toast.success('Shift scheduled.');
    },
    onError: mutationFailure,
  });
  const updateShift = trpc.restaurantShifts.update.useMutation({
    onSuccess: () => {
      refreshRoster();
      setFormOpen(false);
      toast.success('Shift updated.');
    },
    onError: mutationFailure,
  });
  const cancelShift = trpc.restaurantShifts.cancel.useMutation({
    onSuccess: () => {
      refreshRoster();
      setCancelling(null);
      toast.success('Shift cancelled.');
    },
    onError: mutationFailure,
  });

  const formPending = createShift.isPending || updateShift.isPending;
  const permissionDenied = isPermissionError(rosterQuery.error);
  const shifts = useMemo(() => rosterQuery.data ?? [], [rosterQuery.data]);
  const liveCount = shifts.filter((shift) => shift.status === 'SCHEDULED').length;
  const staffOptions = staffQuery.data ?? [];

  const openCreate = () => {
    setEditing(null);
    createShift.reset();
    updateShift.reset();
    setFormOpen(true);
  };

  const openEdit = (shift: Shift) => {
    setEditing(shift);
    createShift.reset();
    updateShift.reset();
    setFormOpen(true);
  };

  const submitShift = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const startAt = new Date(formText(data, 'startAt'));
    const endAt = new Date(formText(data, 'endAt'));
    const role = formText(data, 'role') || null;
    const notes = formText(data, 'notes') || null;
    if (editing) {
      updateShift.mutate({ id: editing.id, startAt, endAt, role, notes });
    } else {
      createShift.mutate({
        branchId: normalizedBranchId,
        staffProfileId: formText(data, 'staffProfileId'),
        startAt,
        endAt,
        role,
        notes,
      });
    }
  };

  const submitCancel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cancelling) return;
    const reason = formText(new FormData(event.currentTarget), 'reason') || null;
    cancelShift.mutate({ id: cancelling.id, reason });
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Roster"
        description="Schedule branch shifts, keep them free of overlaps, and control who can sign in at the terminal."
        actions={
          branchReady && !permissionDenied ? (
            <Button className="min-h-11" onClick={openCreate} disabled={staffOptions.length === 0}>
              Schedule shift
            </Button>
          ) : null
        }
      />

      {!restaurantEnabled ? (
        <SectionCard title="Restaurant module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Shift scheduling is unavailable for this organization. Enable Restaurant Core to build
              a roster.
            </p>
          </div>
        </SectionCard>
      ) : (
        <>
          <SectionCard eyebrow="Roster window" title="Branch and dates">
            <p className="mb-4 max-w-3xl text-sm leading-relaxed text-text-muted">
              Shifts are grouped by the branch&rsquo;s operating day, which the server stamps from
              the branch timezone and business-day cutoff.
            </p>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto] md:items-end">
              <div className="space-y-1.5">
                <label htmlFor="roster-branch" className={labelClass}>
                  Branch ID
                </label>
                <Input
                  id="roster-branch"
                  value={branchId}
                  onChange={(event) => setBranchId(event.target.value)}
                  placeholder="branch_…"
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="roster-from" className={labelClass}>
                  From
                </label>
                <Input
                  id="roster-from"
                  type="date"
                  value={fromDate}
                  onChange={(event) => setFromDate(event.target.value)}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="roster-to" className={labelClass}>
                  To
                </label>
                <Input
                  id="roster-to"
                  type="date"
                  value={toDate}
                  onChange={(event) => setToDate(event.target.value)}
                  className="h-11"
                />
              </div>
              <label className="flex min-h-11 items-center gap-2 text-sm text-text-body">
                <input
                  type="checkbox"
                  className="size-4 rounded-xs border-input accent-[var(--primary)] focus-visible:ring-3 focus-visible:ring-ring/50"
                  checked={includeCancelled}
                  onChange={(event) => setIncludeCancelled(event.target.checked)}
                />
                Show cancelled
              </label>
            </div>
          </SectionCard>

          {permissionDenied ? (
            <SectionCard title="Roster access unavailable">
              <p role="alert" className="text-sm text-destructive">
                You do not have permission to manage restaurant shifts.
              </p>
            </SectionCard>
          ) : (
            <SectionCard
              eyebrow="Shifts"
              title={
                !branchReady
                  ? 'Choose a branch'
                  : rosterQuery.isLoading
                    ? 'Loading roster…'
                    : `${liveCount} scheduled shift${liveCount === 1 ? '' : 's'}`
              }
            >
              {!branchReady ? (
                <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
                  <p className="font-medium text-text-strong">No branch selected.</p>
                  <p className="mt-1 text-sm text-text-muted">
                    Enter a branch ID above to load its roster.
                  </p>
                </div>
              ) : rosterQuery.isLoading ? (
                <RosterSkeleton />
              ) : rosterQuery.error ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/10 p-4 text-sm text-destructive"
                >
                  <span>The roster could not be loaded.</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void rosterQuery.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              ) : shifts.length === 0 ? (
                <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
                  <p className="font-medium text-text-strong">Nothing rostered in this range.</p>
                  <p className="mt-1 text-sm text-text-muted">
                    {staffOptions.length === 0
                      ? 'Assign an active staff profile to this branch before scheduling a shift.'
                      : 'Schedule the first shift, or widen the date range.'}
                  </p>
                </div>
              ) : (
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Operating day</TableHead>
                      <TableHead>Hours</TableHead>
                      <TableHead>Operator</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shifts.map((shift) => {
                      const cancelled = shift.status === 'CANCELLED';
                      return (
                        <TableRow key={shift.id}>
                          <TableCell className="font-medium text-text-strong">
                            {dayFormat.format(new Date(shift.businessDate))}
                          </TableCell>
                          <TableCell className="tabular-nums text-text-body">
                            {timeFormat.format(new Date(shift.startAt))} –{' '}
                            {timeFormat.format(new Date(shift.endAt))}
                          </TableCell>
                          <TableCell>
                            <span className="block text-text-strong">
                              {shift.staffProfile?.displayName ?? 'Unknown operator'}
                            </span>
                          </TableCell>
                          <TableCell className="text-text-muted">{shift.role ?? '—'}</TableCell>
                          <TableCell>
                            <StatusPill
                              status={cancelled ? 'Cancelled' : 'Scheduled'}
                              tone={cancelled ? 'danger' : 'success'}
                            />
                            {cancelled && shift.cancelReason ? (
                              <span className="mt-1 block text-xs text-text-muted">
                                {shift.cancelReason}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={cancelled}
                                onClick={() => openEdit(shift)}
                              >
                                Edit
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={cancelled}
                                onClick={() => {
                                  cancelShift.reset();
                                  setCancelling(shift);
                                }}
                              >
                                Cancel shift
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </SectionCard>
          )}
        </>
      )}

      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          if (!formPending) setFormOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit shift' : 'Schedule shift'}</DialogTitle>
            <DialogDescription>
              Times are entered in your device&rsquo;s time zone. The branch&rsquo;s operating day
              is stamped by the server from its timezone and business-day cutoff.
            </DialogDescription>
          </DialogHeader>
          <form key={editing?.id ?? 'new-shift'} className="space-y-4" onSubmit={submitShift}>
            {createShift.error || updateShift.error ? (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {(createShift.error ?? updateShift.error)?.message}
              </p>
            ) : null}

            {editing ? (
              <p className="rounded-md bg-surface-sunken p-3 text-sm text-text-body">
                Operator:{' '}
                <span className="font-medium text-text-strong">
                  {editing.staffProfile?.displayName ?? editing.staffProfileId}
                </span>
                . Reassigning a shift to another operator means cancelling it and scheduling a
                replacement.
              </p>
            ) : (
              <label className="space-y-1.5">
                <span className={labelClass}>Operator</span>
                <select name="staffProfileId" className={selectClass} required>
                  {staffOptions.map((profile: StaffProfile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className={labelClass}>Starts</span>
                <Input
                  name="startAt"
                  type="datetime-local"
                  required
                  defaultValue={editing ? toLocalInputValue(editing.startAt) : ''}
                  className="h-11"
                />
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Ends</span>
                <Input
                  name="endAt"
                  type="datetime-local"
                  required
                  defaultValue={editing ? toLocalInputValue(editing.endAt) : ''}
                  className="h-11"
                />
              </label>
            </div>

            <label className="space-y-1.5">
              <span className={labelClass}>Role (optional)</span>
              <Input
                name="role"
                maxLength={120}
                placeholder="Cashier, Kitchen, Shift Manager…"
                defaultValue={editing?.role ?? ''}
                className="h-11"
              />
            </label>
            <label className="space-y-1.5">
              <span className={labelClass}>Notes (optional)</span>
              <Input
                name="notes"
                maxLength={1000}
                defaultValue={editing?.notes ?? ''}
                className="h-11"
              />
            </label>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={formPending}
                onClick={() => setFormOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" className="min-h-11" disabled={formPending}>
                {formPending ? 'Saving…' : editing ? 'Save shift' : 'Schedule shift'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelling != null}
        onOpenChange={(open) => {
          if (!open && !cancelShift.isPending) setCancelling(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Cancel this shift?</DialogTitle>
            <DialogDescription>
              The shift stays on the record with its reason, stops granting terminal sign-in, and
              frees the slot for a replacement.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submitCancel}>
            {cancelShift.error ? (
              <p role="alert" className="text-sm text-destructive">
                {cancelShift.error.message}
              </p>
            ) : null}
            <label className="space-y-1.5">
              <span className={labelClass}>Reason (optional)</span>
              <Input name="reason" maxLength={500} className="h-11" />
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={cancelShift.isPending}
                onClick={() => setCancelling(null)}
              >
                Keep shift
              </Button>
              <Button
                type="submit"
                variant="destructive"
                className="min-h-11"
                disabled={cancelShift.isPending}
              >
                {cancelShift.isPending ? 'Cancelling…' : 'Cancel shift'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
