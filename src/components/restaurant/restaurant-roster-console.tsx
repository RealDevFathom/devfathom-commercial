'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { browserUuid } from '@/lib/browser-uuid';

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
import { RestaurantBranchSelect } from './restaurant-branch-select';

/**
 * Completion wave — the branch shift roster console.
 *
 * Deliberately built from the same grammar as the staff console it sits beside
 * (`restaurant-staff-console.tsx`): PageHeader → filter row → bounded table →
 * dialogs for the write paths, Studio semantic tokens throughout, no new visual
 * vocabulary. Branch and operator selection both use tenant-scoped records, so
 * internal identifiers never become operator-entered data.
 *
 * `datetime-local` values are interpreted in the selected branch's IANA
 * timezone. The SERVER still stamps the operating day from that timezone and
 * cutoff; neither the browser zone nor a client-supplied organization id is an
 * authority input.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Shift = RouterOutputs['restaurantShifts']['managerRoster'][number];
type CoreShift = RouterOutputs['restaurantShifts']['list'][number];
type StaffProfile = RouterOutputs['restaurantStaff']['list'][number];
type UiError = { message: string; data?: { code?: string } | null };

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';
const dayFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

function formatBranchTime(value: Date | string, timezone: string): string {
  return new Intl.DateTimeFormat('en', { timeStyle: 'short', timeZone: timezone }).format(
    new Date(value)
  );
}

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

function branchWallClockParts(value: Date | string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
  };
}

function toBranchInputValue(value: Date | string, timezone: string): string {
  const wall = branchWallClockParts(value, timezone);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

function branchInputToDate(value: string, timezone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return new Date(Number.NaN);
  const target = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  );
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wall = branchWallClockParts(new Date(instant), timezone);
    const rendered = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    const adjustment = target - rendered;
    if (adjustment === 0) break;
    instant += adjustment;
  }
  return new Date(instant);
}

function commandKey(kind: string, shiftId: string) {
  return `${kind}:${shiftId}:${browserUuid()}`;
}

function triggerCsvDownload(file: { filename: string; csv: string }) {
  const url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
  const workforceModule = entitlements.modules.find(
    (module) => module.key === 'restaurant-workforce'
  );
  const workforceEnabled =
    workforceModule?.enabled ?? entitlements.enabledModules.includes('restaurant-workforce');
  const coreEnabled = entitlements.enabledModules.includes('restaurant-core');
  const utils = trpc.useUtils();

  const [branchId, setBranchId] = useState('');
  const [fromDate, setFromDate] = useState(() => isoDay(0));
  const [toDate, setToDate] = useState(() => isoDay(6));
  const [includeCancelled, setIncludeCancelled] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [cancelling, setCancelling] = useState<Shift | null>(null);
  const [correcting, setCorrecting] = useState<Shift | null>(null);
  const [replacementByShift, setReplacementByShift] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);

  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: coreEnabled,
  });

  const normalizedBranchId = branchId.trim();
  const branchReady = coreEnabled && normalizedBranchId.length > 0;
  const rosterInput = {
    branchId: normalizedBranchId,
    fromBusinessDate: fromDate,
    toBusinessDate: toDate,
    includeCancelled,
  };

  const coreRosterQuery = trpc.restaurantShifts.list.useQuery(rosterInput, {
    enabled: branchReady && !workforceEnabled,
  });
  const workforceRosterQuery = trpc.restaurantShifts.managerRoster.useQuery(rosterInput, {
    enabled: branchReady && workforceEnabled,
  });
  const rosterQuery = workforceEnabled ? workforceRosterQuery : coreRosterQuery;
  const staffQuery = trpc.restaurantStaff.list.useQuery(
    { branchId: normalizedBranchId, status: 'ACTIVE' },
    { enabled: branchReady }
  );
  const myRosterQuery = trpc.restaurantShifts.myRoster.useQuery(
    {
      from: new Date(`${fromDate}T00:00:00`),
      to: new Date(`${toDate}T23:59:59.999`),
    },
    { enabled: workforceEnabled }
  );
  const swapCandidatesQuery = trpc.restaurantShifts.swapCandidates.useQuery(undefined, {
    enabled: workforceEnabled && Boolean(myRosterQuery.data?.actor),
  });

  const refreshRoster = () => {
    void utils.restaurantShifts.list.invalidate(rosterInput);
    void utils.restaurantShifts.managerRoster.invalidate(rosterInput);
    void utils.restaurantShifts.myRoster.invalidate();
  };
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
  const clockInMutation = trpc.restaurantShifts.clockIn.useMutation({
    onSuccess: refreshRoster,
    onError: mutationFailure,
  });
  const startBreakMutation = trpc.restaurantShifts.startBreak.useMutation({
    onSuccess: refreshRoster,
    onError: mutationFailure,
  });
  const endBreakMutation = trpc.restaurantShifts.endBreak.useMutation({
    onSuccess: refreshRoster,
    onError: mutationFailure,
  });
  const clockOutMutation = trpc.restaurantShifts.clockOut.useMutation({
    onSuccess: refreshRoster,
    onError: mutationFailure,
  });
  const requestSwapMutation = trpc.restaurantShifts.requestSwap.useMutation({
    onSuccess: () => {
      refreshRoster();
      toast.success('Swap request sent for manager review.');
    },
    onError: mutationFailure,
  });
  const reviewSwapMutation = trpc.restaurantShifts.reviewSwap.useMutation({
    onSuccess: () => {
      refreshRoster();
      toast.success('Swap decision recorded.');
    },
    onError: mutationFailure,
  });
  const correctTimeMutation = trpc.restaurantShifts.correctTime.useMutation({
    onSuccess: () => {
      refreshRoster();
      setCorrecting(null);
      toast.success('Time correction appended.');
    },
    onError: mutationFailure,
  });

  const formPending = createShift.isPending || updateShift.isPending;
  const permissionDenied = isPermissionError(rosterQuery.error);
  const shifts = useMemo<Shift[]>(() => {
    if (workforceEnabled) return workforceRosterQuery.data ?? [];
    const branch = branchesQuery.data?.find((candidate) => candidate.id === normalizedBranchId);
    return (coreRosterQuery.data ?? []).map((shift: CoreShift) => ({
      ...shift,
      clockedInAt: null,
      clockedOutAt: null,
      breaks: [],
      adjustments: [],
      swapRequests: [],
      attendanceStatus: shift.status === 'CANCELLED' ? 'CANCELLED' : 'SCHEDULED',
      lateMinutes: 0,
      lateThresholdMinutes: 5,
      branch: {
        id: shift.branchId,
        name: branch?.name ?? 'Selected branch',
        timezone: branch?.timezone ?? 'UTC',
      },
    }));
  }, [
    branchesQuery.data,
    coreRosterQuery.data,
    normalizedBranchId,
    workforceEnabled,
    workforceRosterQuery.data,
  ]);
  const liveCount = shifts.filter((shift) => shift.status === 'SCHEDULED').length;
  const staffOptions = staffQuery.data ?? [];
  const branchTimezone =
    branchesQuery.data?.find((branch) => branch.id === normalizedBranchId)?.timezone ?? 'UTC';

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
    const startAt = branchInputToDate(formText(data, 'startAt'), branchTimezone);
    const endAt = branchInputToDate(formText(data, 'endAt'), branchTimezone);
    const role = formText(data, 'role') || null;
    const notes = formText(data, 'notes') || null;
    if (editing) {
      updateShift.mutate({
        id: editing.id,
        expectedVersion: editing.version,
        startAt,
        endAt,
        role,
        notes,
      });
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
    cancelShift.mutate({ id: cancelling.id, expectedVersion: cancelling.version, reason });
  };

  const submitCorrection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!correcting) return;
    const data = new FormData(event.currentTarget);
    const [kind, breakId] = formText(data, 'kind').split(':') as [
      'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END',
      string | undefined,
    ];
    correctTimeMutation.mutate({
      shiftId: correcting.id,
      branchId: correcting.branchId,
      kind,
      breakId,
      correctedAt: branchInputToDate(formText(data, 'correctedAt'), branchTimezone),
      reason: formText(data, 'reason'),
    });
  };

  const exportCsv = async () => {
    if (!branchReady) return;
    setExporting(true);
    try {
      const file = await utils.restaurantShifts.exportAttendanceCsv.fetch({
        branchId: rosterInput.branchId,
        fromBusinessDate: rosterInput.fromBusinessDate,
        toBusinessDate: rosterInput.toBusinessDate,
      });
      triggerCsvDownload(file);
    } catch (error) {
      mutationFailure(error as { message: string });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Roster"
        description="Publish branch shifts, record server-timestamped attendance, and resolve employee swap requests."
        actions={
          branchReady && !permissionDenied ? (
            <Button className="min-h-11" onClick={openCreate} disabled={staffOptions.length === 0}>
              Schedule shift
            </Button>
          ) : null
        }
      />

      {!workforceEnabled ? (
        <SectionCard title="Restaurant Workforce disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Core scheduling remains available below. Enable Restaurant Workforce to record
              attendance, manage breaks and swaps, and export timekeeping.
            </p>
          </div>
        </SectionCard>
      ) : (
        <SectionCard eyebrow="My shift" title="Employee timekeeping" titleLevel={2}>
          {myRosterQuery.isLoading ? (
            <RosterSkeleton />
          ) : myRosterQuery.error ? (
            <p role="alert" className="text-sm text-text-muted">
              {isPermissionError(myRosterQuery.error as UiError)
                ? 'An active staff profile is required for employee timekeeping.'
                : 'Your shifts could not be loaded. Try again.'}
            </p>
          ) : (myRosterQuery.data?.shifts.length ?? 0) === 0 ? (
            <div className="rounded-md border border-dashed border-border-default px-5 py-8 text-center">
              <p className="font-medium text-text-strong">No shifts in this date range.</p>
              <p className="mt-1 text-sm text-text-muted">
                Your manager&rsquo;s published assignments will appear here by branch name.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {myRosterQuery.data!.shifts.map((shift) => {
                const activeBreak = shift.breaks.find((row) => row.endedAt === null);
                const pendingSwap = shift.swapRequests.find((request) => !request.decision);
                const replacement = replacementByShift[shift.id] ?? '';
                return (
                  <article
                    key={shift.id}
                    className="rounded-md border border-border-subtle bg-surface-sunken p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-text-strong">
                          {shift.branch.name} · {shift.role ?? 'Assigned shift'}
                        </p>
                        <p className="mt-1 text-sm tabular-nums text-text-muted">
                          {dayFormat.format(new Date(shift.businessDate))},{' '}
                          {formatBranchTime(shift.startAt, shift.branch.timezone)} –{' '}
                          {formatBranchTime(shift.endAt, shift.branch.timezone)}{' '}
                          <span className="font-mono text-[0.6875rem]">
                            {shift.branch.timezone}
                          </span>
                        </p>
                      </div>
                      <StatusPill
                        status={shift.attendanceStatus.replaceAll('_', ' ')}
                        tone={
                          shift.attendanceStatus === 'LATE' ||
                          shift.attendanceStatus === 'COMPLETE_LATE'
                            ? 'warning'
                            : 'neutral'
                        }
                      />
                    </div>
                    {shift.attendanceStatus === 'LATE' ||
                    shift.attendanceStatus === 'COMPLETE_LATE' ? (
                      <p className="mt-2 text-xs text-text-muted">
                        {shift.lateMinutes} minutes after the {shift.lateThresholdMinutes}-minute
                        attendance threshold.
                      </p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2" aria-label="Timekeeping actions">
                      {!shift.clockedInAt ? (
                        <Button
                          size="sm"
                          onClick={() =>
                            clockInMutation.mutate({
                              shiftId: shift.id,
                              idempotencyKey: commandKey('clock-in', shift.id),
                            })
                          }
                          disabled={clockInMutation.isPending}
                        >
                          Clock in
                        </Button>
                      ) : !shift.clockedOutAt ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              (activeBreak ? endBreakMutation : startBreakMutation).mutate({
                                shiftId: shift.id,
                                idempotencyKey: commandKey(
                                  activeBreak ? 'break-end' : 'break-start',
                                  shift.id
                                ),
                              })
                            }
                            disabled={startBreakMutation.isPending || endBreakMutation.isPending}
                          >
                            {activeBreak ? 'End break' : 'Start break'}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() =>
                              clockOutMutation.mutate({
                                shiftId: shift.id,
                                idempotencyKey: commandKey('clock-out', shift.id),
                              })
                            }
                            disabled={Boolean(activeBreak) || clockOutMutation.isPending}
                          >
                            Clock out
                          </Button>
                        </>
                      ) : (
                        <span className="text-sm text-text-muted">Timekeeping complete.</span>
                      )}
                    </div>
                    <div className="mt-4 border-t border-border-subtle pt-4">
                      {pendingSwap ? (
                        <p className="text-sm text-text-muted">
                          Swap pending with {pendingSwap.replacement.displayName}.
                        </p>
                      ) : shift.status === 'SCHEDULED' && !shift.clockedInAt ? (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <label className="min-w-0 flex-1">
                            <span className={labelClass}>Replacement employee</span>
                            <StudioSelect
                              className={selectClass}
                              value={replacement}
                              onChange={(event) =>
                                setReplacementByShift((current) => ({
                                  ...current,
                                  [shift.id]: event.target.value,
                                }))
                              }
                            >
                              <option value="">Choose a colleague</option>
                              {(swapCandidatesQuery.data ?? []).map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.displayName}
                                </option>
                              ))}
                            </StudioSelect>
                          </label>
                          <Button
                            className="self-end"
                            size="sm"
                            variant="secondary"
                            disabled={!replacement || requestSwapMutation.isPending}
                            onClick={() =>
                              requestSwapMutation.mutate({
                                shiftId: shift.id,
                                replacementStaffProfileId: replacement,
                                idempotencyKey: commandKey('swap', shift.id),
                              })
                            }
                          >
                            Request swap
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </SectionCard>
      )}

      <SectionCard eyebrow="Roster window" title="Branch and dates">
        <p className="mb-4 max-w-3xl text-sm leading-relaxed text-text-muted">
          Shifts are grouped by the branch&rsquo;s operating day, which the server stamps from the
          branch timezone and business-day cutoff.
        </p>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto] md:items-end">
          <div className="space-y-1.5">
            <label htmlFor="roster-branch" className={labelClass}>
              Branch
            </label>
            <RestaurantBranchSelect
              id="roster-branch"
              branches={branchesQuery.data ?? []}
              loading={branchesQuery.isLoading}
              error={Boolean(branchesQuery.error)}
              value={branchId}
              onChange={setBranchId}
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
        {workforceEnabled && branchReady && !permissionDenied ? (
          <div className="mt-4 flex justify-end border-t border-border-subtle pt-4">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={exporting}
              onClick={() => void exportCsv()}
            >
              {exporting ? 'Preparing export…' : 'Export attendance CSV'}
            </Button>
          </div>
        ) : null}
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
                Select a branch above to load its roster.
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
            <Table className="min-w-[1120px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Operating day</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead>Operator</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Attendance</TableHead>
                  <TableHead>Swap request</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shifts.map((shift) => {
                  const cancelled = shift.status === 'CANCELLED';
                  const pendingSwap = shift.swapRequests.find((request) => !request.decision);
                  return (
                    <TableRow key={shift.id}>
                      <TableCell className="font-medium text-text-strong">
                        {dayFormat.format(new Date(shift.businessDate))}
                      </TableCell>
                      <TableCell className="tabular-nums text-text-body">
                        {formatBranchTime(shift.startAt, shift.branch.timezone)} –{' '}
                        {formatBranchTime(shift.endAt, shift.branch.timezone)}
                        <span className="mt-1 block font-mono text-[0.625rem] text-text-muted">
                          {shift.branch.timezone}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="block text-text-strong">
                          {shift.staffProfile?.displayName ?? 'Unknown operator'}
                        </span>
                      </TableCell>
                      <TableCell className="text-text-muted">{shift.role ?? '—'}</TableCell>
                      <TableCell>
                        <StatusPill
                          status={shift.attendanceStatus.replaceAll('_', ' ')}
                          tone={
                            cancelled
                              ? 'danger'
                              : shift.attendanceStatus === 'LATE' ||
                                  shift.attendanceStatus === 'COMPLETE_LATE' ||
                                  shift.attendanceStatus === 'ABSENT'
                                ? 'warning'
                                : 'success'
                          }
                        />
                        {shift.lateMinutes > 0 ? (
                          <span className="mt-1 block text-xs text-text-muted">
                            {shift.lateMinutes} min late
                          </span>
                        ) : null}
                        {cancelled && shift.cancelReason ? (
                          <span className="mt-1 block text-xs text-text-muted">
                            {shift.cancelReason}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {pendingSwap ? (
                          <div className="space-y-2">
                            <p className="text-sm text-text-body">
                              {pendingSwap.requestedBy.displayName} →{' '}
                              {pendingSwap.replacement.displayName}
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              <Button
                                size="sm"
                                aria-label={`Approve swap for ${pendingSwap.requestedBy.displayName}`}
                                onClick={() =>
                                  reviewSwapMutation.mutate({
                                    requestId: pendingSwap.id,
                                    branchId: shift.branchId,
                                    decision: 'APPROVED',
                                    idempotencyKey: commandKey('swap-approve', shift.id),
                                  })
                                }
                                disabled={reviewSwapMutation.isPending}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                aria-label={`Reject swap for ${pendingSwap.requestedBy.displayName}`}
                                onClick={() =>
                                  reviewSwapMutation.mutate({
                                    requestId: pendingSwap.id,
                                    branchId: shift.branchId,
                                    decision: 'REJECTED',
                                    idempotencyKey: commandKey('swap-reject', shift.id),
                                  })
                                }
                                disabled={reviewSwapMutation.isPending}
                              >
                                Reject
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={cancelled}
                            onClick={() => openEdit(shift)}
                          >
                            Edit
                          </Button>
                          {workforceEnabled ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={cancelled}
                              onClick={() => setCorrecting(shift)}
                            >
                              Correct time
                            </Button>
                          ) : null}
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
              Times are entered in {branchTimezone}. The branch&rsquo;s operating day is stamped by
              the server from that timezone and its business-day cutoff.
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
                  {editing.staffProfile?.displayName ?? 'Operator name unavailable'}
                </span>
                . Reassigning a shift to another operator means cancelling it and scheduling a
                replacement.
              </p>
            ) : (
              <label className="space-y-1.5">
                <span className={labelClass}>Operator</span>
                <StudioSelect name="staffProfileId" className={selectClass} required>
                  {staffOptions.map((profile: StaffProfile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.displayName}
                    </option>
                  ))}
                </StudioSelect>
              </label>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className={labelClass}>Starts</span>
                <Input
                  name="startAt"
                  type="datetime-local"
                  required
                  defaultValue={editing ? toBranchInputValue(editing.startAt, branchTimezone) : ''}
                  className="h-11"
                />
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Ends</span>
                <Input
                  name="endAt"
                  type="datetime-local"
                  required
                  defaultValue={editing ? toBranchInputValue(editing.endAt, branchTimezone) : ''}
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
        open={correcting != null}
        onOpenChange={(open) => {
          if (!open && !correctTimeMutation.isPending) setCorrecting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Append a time correction</DialogTitle>
            <DialogDescription>
              Existing server timestamps remain unchanged. A missing punch is recorded as absent,
              and this reasoned adjustment is added to the permanent workforce history. Enter the
              correction in {branchTimezone}.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submitCorrection}>
            {correctTimeMutation.error ? (
              <p role="alert" className="text-sm text-destructive">
                {correctTimeMutation.error.message}
              </p>
            ) : null}
            <label className="space-y-1.5">
              <span className={labelClass}>Timestamp</span>
              <StudioSelect name="kind" className={selectClass} required>
                <option value="CLOCK_IN">
                  {correcting?.clockedInAt ? 'Correct clock in' : 'Add missing clock in'}
                </option>
                <option value="CLOCK_OUT">
                  {correcting?.clockedOutAt ? 'Correct clock out' : 'Add missing clock out'}
                </option>
                {correcting?.breaks.flatMap((item, index) => [
                  <option key={`${item.id}-start`} value={`BREAK_START:${item.id}`}>
                    Correct break {index + 1} start
                  </option>,
                  <option key={`${item.id}-end`} value={`BREAK_END:${item.id}`}>
                    {item.endedAt
                      ? `Correct break ${index + 1} end`
                      : `Add missing break ${index + 1} end`}
                  </option>,
                ])}
              </StudioSelect>
            </label>
            <label className="space-y-1.5">
              <span className={labelClass}>Corrected time</span>
              <Input name="correctedAt" type="datetime-local" className="h-11" required />
            </label>
            <label className="space-y-1.5">
              <span className={labelClass}>Reason</span>
              <Input name="reason" maxLength={500} className="h-11" required />
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={correctTimeMutation.isPending}
                onClick={() => setCorrecting(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={correctTimeMutation.isPending}>
                {correctTimeMutation.isPending ? 'Appending…' : 'Append correction'}
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
