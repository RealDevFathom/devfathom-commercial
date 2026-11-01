'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button, buttonVariants } from '@/components/ui/button';
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
import { PrintBridgeEnrollment } from './print-bridge-enrollment';
import { PrinterInventoryPanel } from './printer-inventory-panel';

type Device = inferRouterOutputs<AppRouter>['restaurantDevices']['list'][number];
type UiError = { message: string; data?: { code?: string } | null };

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

function isPermissionError(error?: UiError | null) {
  return error?.data?.code === 'FORBIDDEN' || error?.data?.code === 'UNAUTHORIZED';
}

function formText(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

function healthTone(health: Device['health']) {
  if (health === 'HEALTHY') return 'success' as const;
  if (health === 'STALE') return 'warning' as const;
  if (health === 'REVOKED') return 'danger' as const;
  return 'neutral' as const;
}

export function RestaurantDevicesConsole() {
  const entitlements = useEntitlements();
  const { data: session, status: sessionStatus } = useSession();
  const bridgeOwner =
    sessionStatus === 'authenticated' &&
    session?.user?.id &&
    session.user.organizationId === entitlements.organizationId
      ? `${entitlements.organizationId}:${session.user.id}`
      : null;
  const restaurantModule = entitlements.modules.find((module) => module.key === 'restaurant-core');
  const restaurantEnabled =
    restaurantModule?.enabled ?? entitlements.enabledModules.includes('restaurant-core');
  const camerasEnabled = entitlements.enabledModules.includes('restaurant-integrations');
  const utils = trpc.useUtils();
  const devicesQuery = trpc.restaurantDevices.list.useQuery(undefined, {
    enabled: restaurantEnabled,
    refetchInterval: 60_000,
  });
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: restaurantEnabled,
  });

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const [enrollmentKind, setEnrollmentKind] = useState<'POS' | 'KDS'>('POS');
  const [enrollmentBranchId, setEnrollmentBranchId] = useState('');
  const [enrollmentStationId, setEnrollmentStationId] = useState('');
  const [newStationName, setNewStationName] = useState('Kitchen');
  const [enrollError, setEnrollError] = useState('');
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [deviceAction, setDeviceAction] = useState<'revoke' | 'rotate'>('revoke');
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [oneTimeDeviceName, setOneTimeDeviceName] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [coAuthError, setCoAuthError] = useState('');
  const approversQuery = trpc.restaurantDevices.listApprovers.useQuery(
    { deviceId: selectedDevice?.id ?? '' },
    { enabled: restaurantEnabled && selectedDevice !== null }
  );

  const refreshDevices = () => {
    void utils.restaurantDevices.list.invalidate();
    setInventoryRevision((value) => value + 1);
  };
  const stationsQuery = trpc.restaurantFloor.listStations.useQuery(
    { branchId: enrollmentBranchId },
    { enabled: enrollOpen && enrollmentKind === 'KDS' && Boolean(enrollmentBranchId) }
  );
  const activeStations = (stationsQuery.data ?? []).filter((station) => station.active);
  const createStation = trpc.restaurantFloor.createStation.useMutation({
    onSuccess: (station) => {
      void utils.restaurantFloor.listStations.invalidate({ branchId: enrollmentBranchId });
      // Select what was just created: an operator who names a station in this
      // dialog wants to enroll against it, and making them find it in a select
      // that was empty a moment ago is a step with no decision in it.
      if (station) setEnrollmentStationId(station.id);
      setNewStationName('');
      setEnrollError('');
      toast.success(`Station “${station?.name ?? 'Kitchen'}” created.`);
    },
    onError: (error) => toast.error(error.message),
  });
  const revokeDevice = trpc.restaurantDevices.revoke.useMutation({
    onSuccess: () => {
      setSelectedDevice(null);
      setCoAuthError('');
      refreshDevices();
      toast.success('Device revoked.');
    },
    onError: (error) => {
      setCoAuthError(error.message);
      toast.error(error.message);
    },
  });
  const rotateDevice = trpc.restaurantDevices.rotate.useMutation({
    onSuccess: (result) => {
      setSelectedDevice(null);
      setCoAuthError('');
      setOneTimeSecret(result.secret);
      setOneTimeDeviceName(selectedDevice?.name ?? 'device');
      setCopyStatus('idle');
      refreshDevices();
      toast.success('Device secret rotated. Copy it now; it will not be shown again.');
    },
    onError: (error) => {
      setCoAuthError(error.message);
      toast.error(error.message);
    },
  });

  const actingStaff = approversQuery.data?.actingStaff ?? null;
  const selfApprovalAllowed = approversQuery.data?.selfApprovalAllowed ?? false;
  // A solo branch owner may approve their own action with a fresh PIN; the
  // server re-verifies the exception on every mutation.
  const approvers = [
    ...(selfApprovalAllowed && actingStaff
      ? [{ id: actingStaff.id, displayName: `${actingStaff.displayName} (you, PIN only)` }]
      : []),
    ...(approversQuery.data?.approvers ?? []),
  ];

  const permissionDenied = isPermissionError(devicesQuery.error);
  /**
   * WHA-1181 (9) — the station requirement is enforced here rather than by
   * `required` on the select. The native constraint fired an untargeted "Please
   * select an item in the list" tooltip on a branch that had no station to
   * select, which is a dead end rather than a validation message. Everything
   * else on this form keeps its native validation, which runs before this
   * handler is ever reached.
   */
  const submitEnrollment = (event: FormEvent<HTMLFormElement>) => {
    if (enrollmentKind !== 'KDS') return;
    if (enrollmentStationId) {
      setEnrollError('');
      return;
    }
    event.preventDefault();
    setEnrollError(
      activeStations.length === 0
        ? 'Create a KDS station for this branch before enrolling a kitchen display.'
        : 'Choose the KDS station this display shows tickets for.'
    );
  };
  const submitRevocation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedDevice) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const actingStaffProfileId = deviceAction === 'revoke' ? actingStaff?.id : null;
    const selfApproval = Boolean(actingStaff) && approvingStaffProfileId === actingStaff?.id;
    const approvingStaffProfileId = formText(data, 'approvingStaffProfileId');
    const approvingSecret = formText(data, 'approvingSecret');
    const approvingType = formText(data, 'approvingType') as 'PIN' | 'BADGE';
    const reason = formText(data, 'reason');
    const secretInput = form.elements.namedItem('approvingSecret');
    if (secretInput instanceof HTMLInputElement) secretInput.value = '';
    setCoAuthError('');

    if (selfApproval && !selfApprovalAllowed) {
      setCoAuthError('Acting and approving staff must be different active people.');
      return;
    }
    if (selfApproval && approvingType !== 'PIN') {
      setCoAuthError(
        'Approving your own action as the only branch staff member requires your PIN.'
      );
      return;
    }

    const payload = {
      deviceId: selectedDevice.id,
      approvingStaffProfileId,
      approvingType,
      approvingSecret,
      reason,
    };
    if (deviceAction === 'rotate') {
      rotateDevice.mutate(payload, { onSettled: () => rotateDevice.reset() });
    } else {
      revokeDevice.mutate(
        { ...payload, actingStaffProfileId: actingStaffProfileId ?? '' },
        { onSettled: () => revokeDevice.reset() }
      );
    }
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Devices"
        description="Enroll, monitor, and revoke restaurant terminals with manager co-authorization."
        actions={
          restaurantEnabled && !permissionDenied ? (
            <div className="flex flex-wrap gap-2">
              <Link
                className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}
                href="/settings"
              >
                Printer settings and test print
              </Link>
              {camerasEnabled ? (
                <Link
                  className={buttonVariants({ variant: 'secondary' })}
                  href="/restaurant/integrations/cameras"
                >
                  Cameras →
                </Link>
              ) : null}
              {bridgeOwner ? (
                <PrintBridgeEnrollment
                  key={bridgeOwner}
                  ownerKey={bridgeOwner}
                  branches={branchesQuery.error ? [] : (branchesQuery.data ?? [])}
                  onCreated={refreshDevices}
                />
              ) : null}
              <Button
                className="min-h-11"
                onClick={() => {
                  setEnrollmentKind('POS');
                  setEnrollmentBranchId('');
                  setEnrollmentStationId('');
                  setNewStationName('Kitchen');
                  setEnrollError('');
                  setEnrollOpen(true);
                }}
              >
                Enroll device
              </Button>
            </div>
          ) : null
        }
      />

      {!restaurantEnabled ? (
        <SectionCard title="Restaurant module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Restaurant device tools are unavailable for this organization. Enable Restaurant Core
              to load or enroll devices.
            </p>
          </div>
        </SectionCard>
      ) : permissionDenied ? (
        <SectionCard title="Device access unavailable">
          <p role="alert" className="text-sm text-destructive">
            Administrator permission is required to manage restaurant devices.
          </p>
        </SectionCard>
      ) : (
        <SectionCard
          eyebrow="Terminal registry"
          title={
            devicesQuery.isLoading
              ? 'Loading devices…'
              : `${devicesQuery.data?.length ?? 0} device${devicesQuery.data?.length === 1 ? '' : 's'}`
          }
          titleLevel={2}
        >
          {devicesQuery.isLoading ? (
            <div role="status" aria-label="Loading restaurant devices" className="space-y-3 py-2">
              {[0, 1, 2, 3].map((row) => (
                <Skeleton key={row} className="h-12 w-full" />
              ))}
            </div>
          ) : devicesQuery.error ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/10 p-4 text-sm text-destructive"
            >
              <span>Devices could not be loaded.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void devicesQuery.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : devicesQuery.data?.length ? (
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devicesQuery.data.map((device) => (
                  <TableRow key={device.id}>
                    <TableCell>
                      <span className="block font-medium text-text-strong">{device.name}</span>
                    </TableCell>
                    <TableCell className="text-text-strong">{device.branch.name}</TableCell>
                    <TableCell className="text-text-strong">{device.kind}</TableCell>
                    <TableCell>
                      <StatusPill
                        status={device.status}
                        tone={device.status === 'ACTIVE' ? 'success' : 'danger'}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusPill status={device.health} tone={healthTone(device.health)} />
                    </TableCell>
                    <TableCell className="text-text-muted">
                      {device.lastSeenAt ? dateFormat.format(new Date(device.lastSeenAt)) : 'Never'}
                    </TableCell>
                    <TableCell className="text-right">
                      {device.status !== 'REVOKED' ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDeviceAction('rotate');
                              setCoAuthError('');
                              setSelectedDevice(device);
                            }}
                          >
                            Rotate secret
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                              setDeviceAction('revoke');
                              setCoAuthError('');
                              setSelectedDevice(device);
                            }}
                          >
                            Revoke {device.name}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-text-faint">No actions</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
              <p className="font-medium text-text-strong">No restaurant devices enrolled.</p>
              <p className="mt-1 text-sm text-text-muted">
                Enroll a terminal to generate its one-time secret.
              </p>
            </div>
          )}
        </SectionCard>
      )}

      {restaurantEnabled && bridgeOwner && !permissionDenied ? (
        <PrinterInventoryPanel
          key={bridgeOwner}
          ownerKey={bridgeOwner}
          refreshVersion={inventoryRevision}
        />
      ) : null}

      <Dialog
        open={enrollOpen}
        onOpenChange={(open) => {
          setEnrollOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enroll this browser</DialogTitle>
            <DialogDescription>
              This browser becomes a dedicated terminal and your administrator session ends.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            method="post"
            action="/api/restaurant/devices/browser-enroll"
            onSubmit={submitEnrollment}
          >
            <label className="space-y-1.5">
              <span className={labelClass}>Device name</span>
              <Input name="name" required maxLength={120} className="h-11" />
            </label>
            <div className="space-y-1.5">
              <label htmlFor="device-branch-id" className={labelClass}>
                Branch
              </label>
              <RestaurantBranchSelect
                id="device-branch-id"
                name="branchId"
                required
                branches={branchesQuery.data ?? []}
                loading={branchesQuery.isLoading}
                error={Boolean(branchesQuery.error)}
                value={enrollmentBranchId}
                onChange={(value) => {
                  setEnrollmentBranchId(value);
                  // Stations are per branch; a selection from the previous one
                  // would enroll this display against another branch's screen.
                  setEnrollmentStationId('');
                  setEnrollError('');
                }}
              />
            </div>
            <label className="space-y-1.5">
              <span className={labelClass}>Device kind</span>
              <select
                name="kind"
                value={enrollmentKind}
                onChange={(event) => {
                  setEnrollmentKind(event.target.value as 'POS' | 'KDS');
                  setEnrollError('');
                }}
                className={selectClass}
              >
                <option value="POS">POS register</option>
                <option value="KDS">Kitchen display</option>
              </select>
            </label>
            {/*
              WHA-1181 (9) — the station field belongs to a kitchen display and
              nothing else, and it used to be a bare `required` select. On a new
              organization, which has no stations, that select was empty and
              unsatisfiable: submitting produced the browser's native "Please
              select an item in the list" tooltip over a control offering no
              item, with no explanation and nowhere to go. `required` is gone and
              the form validates this field itself in `submitEnrollment`, so the
              empty case can say what a station is and offer to create one
              inline. The other fields keep their native validation — only this
              one had an unsatisfiable state to explain.
            */}
            {enrollmentKind === 'KDS' ? (
              <div className="space-y-1.5">
                <label htmlFor="device-station-id" className={labelClass}>
                  KDS station
                </label>
                {stationsQuery.isLoading ? (
                  <Skeleton className="h-11 w-full" />
                ) : !enrollmentBranchId ? (
                  <p className="text-sm text-text-muted">Select a branch to choose its station.</p>
                ) : stationsQuery.error ? (
                  /*
                   * A failed lookup is NOT an empty branch. Kitchen stations
                   * live behind the POS module, so an organization without it
                   * gets FORBIDDEN here — and telling that operator "this branch
                   * has no station yet" would send them to a Create action that
                   * fails for the same reason. Say which of the two it is.
                   */
                  <p role="alert" className="text-sm text-destructive">
                    {isPermissionError(stationsQuery.error)
                      ? 'Kitchen displays need the Restaurant POS module. Enable it for this organization, then enroll this display.'
                      : 'Stations could not be loaded for this branch. Close this dialog and try again.'}
                  </p>
                ) : activeStations.length === 0 ? (
                  <div className="space-y-3 rounded-md border border-dashed border-border-default p-3">
                    <p className="text-sm text-text-muted">
                      This branch has no KDS station yet. A KDS station is a kitchen screen that
                      receives tickets — e.g. Kitchen, Grill, Bar.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label="New station name"
                        value={newStationName}
                        onChange={(event) => setNewStationName(event.target.value)}
                        placeholder="Kitchen"
                        maxLength={120}
                        className="h-11 w-full sm:w-56"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={createStation.isPending || newStationName.trim().length === 0}
                        onClick={() =>
                          createStation.mutate({
                            branchId: enrollmentBranchId,
                            name: newStationName.trim(),
                          })
                        }
                      >
                        {createStation.isPending ? 'Creating…' : 'Create station'}
                      </Button>
                    </div>
                    {createStation.error ? (
                      <p role="alert" className="text-sm text-destructive">
                        {createStation.error.message}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <select
                    id="device-station-id"
                    name="stationId"
                    value={enrollmentStationId}
                    onChange={(event) => {
                      setEnrollmentStationId(event.target.value);
                      setEnrollError('');
                    }}
                    aria-invalid={enrollError ? true : undefined}
                    aria-describedby={enrollError ? 'device-station-error' : undefined}
                    className={selectClass}
                  >
                    <option value="">Select a station</option>
                    {activeStations.map((station) => (
                      <option key={station.id} value={station.id}>
                        {station.name}
                      </option>
                    ))}
                  </select>
                )}
                {enrollError ? (
                  <p id="device-station-error" role="alert" className="text-sm text-destructive">
                    {enrollError}
                  </p>
                ) : null}
                <p className="text-xs text-text-muted">
                  Stations are required only for kitchen display screens; printer routes are
                  configured separately in Settings → Printing.
                </p>
              </div>
            ) : null}
            <label className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-text-body">
              <input
                type="checkbox"
                name="confirmation"
                value="confirmed"
                required
                className="mt-0.5 size-4 accent-current"
              />
              <span>
                I understand this browser will sign out of administration and open only as this
                terminal until the device is revoked or enrollment expires.
              </span>
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setEnrollOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" className="min-h-11">
                Enroll this browser
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedDevice != null}
        onOpenChange={(open) => {
          if (!open && !revokeDevice.isPending && !rotateDevice.isPending) {
            setSelectedDevice(null);
            setCoAuthError('');
            revokeDevice.reset();
            rotateDevice.reset();
          }
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {deviceAction === 'rotate' ? 'Rotate' : 'Revoke'} {selectedDevice?.name}?
            </DialogTitle>
            <DialogDescription>
              {deviceAction === 'rotate'
                ? 'The current secret stops working immediately. A distinct active staff approver is required.'
                : 'Revocation is immediate and requires a distinct active staff approver.'}
              {selfApprovalAllowed
                ? ' As the only active staff member at this branch, you may approve with your own PIN.'
                : null}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submitRevocation}>
            {coAuthError ? (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {coAuthError}
              </p>
            ) : null}
            {approversQuery.isLoading ? (
              <p role="status" className="rounded-md bg-muted p-3 text-sm text-text-muted">
                Loading eligible approvers…
              </p>
            ) : approversQuery.error ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              >
                <span>Eligible approvers could not be loaded for this device.</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void approversQuery.refetch()}
                >
                  Retry approvers
                </Button>
              </div>
            ) : approvers.length === 0 ? (
              <p role="alert" className="rounded-md bg-warning/10 p-3 text-sm text-warning">
                No distinct active device manager is eligible to approve this action.
              </p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {deviceAction === 'revoke' ? (
                <div className="space-y-1.5">
                  <span className={labelClass}>Acting staff</span>
                  <p className="flex h-11 items-center rounded-md border border-input bg-muted px-3 text-sm text-text-strong">
                    {actingStaff?.displayName ?? 'Loading authenticated staff…'}
                  </p>
                </div>
              ) : null}
              <label className="space-y-1.5">
                <span className={labelClass}>Approving staff</span>
                <select
                  name="approvingStaffProfileId"
                  required
                  defaultValue=""
                  className={selectClass}
                >
                  <option value="" disabled>
                    Select approving staff
                  </option>
                  {approvers.map((staff) => (
                    <option key={staff.id} value={staff.id}>
                      {staff.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Approving credential type</span>
                <select name="approvingType" defaultValue="PIN" className={selectClass}>
                  <option value="PIN">PIN</option>
                  <option value="BADGE">Badge</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Approving PIN or badge secret</span>
                <Input
                  name="approvingSecret"
                  type="password"
                  required
                  aria-invalid={coAuthError ? true : undefined}
                  autoComplete="new-password"
                  className="h-11"
                />
              </label>
            </div>
            <label className="space-y-1.5">
              <span className={labelClass}>Reason</span>
              <Input name="reason" required className="h-11" />
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={revokeDevice.isPending || rotateDevice.isPending}
                onClick={() => {
                  setSelectedDevice(null);
                  setCoAuthError('');
                  revokeDevice.reset();
                  rotateDevice.reset();
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                className="min-h-11"
                disabled={
                  revokeDevice.isPending ||
                  rotateDevice.isPending ||
                  approversQuery.isLoading ||
                  Boolean(approversQuery.error) ||
                  !actingStaff ||
                  approvers.length === 0
                }
              >
                {rotateDevice.isPending
                  ? 'Rotating…'
                  : revokeDevice.isPending
                    ? 'Revoking…'
                    : deviceAction === 'rotate'
                      ? 'Confirm rotation'
                      : 'Confirm revocation'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={oneTimeSecret !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOneTimeSecret(null);
            setOneTimeDeviceName(null);
            setCopyStatus('idle');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New secret for {oneTimeDeviceName ?? 'device'}</DialogTitle>
            <DialogDescription>
              Copy this secret now. For safety, it will be cleared when this dialog closes and
              cannot be recovered from DevFathom.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label htmlFor="one-time-device-secret" className={labelClass}>
              One-time device secret
            </label>
            <Input
              id="one-time-device-secret"
              readOnly
              value={oneTimeSecret ?? ''}
              className="h-11 font-mono"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              type="button"
              className="min-h-11 w-full"
              onClick={async () => {
                if (!oneTimeSecret) return;
                try {
                  await navigator.clipboard.writeText(oneTimeSecret);
                  setCopyStatus('copied');
                  toast.success('Secret copied.');
                } catch {
                  setCopyStatus('error');
                  toast.error(
                    'Unable to copy automatically. Select the secret and copy it manually.'
                  );
                }
              }}
            >
              {copyStatus === 'copied' ? 'Copied' : 'Copy secret'}
            </Button>
            <p
              className={
                copyStatus === 'error' ? 'text-sm text-destructive' : 'text-sm text-text-muted'
              }
              role={copyStatus === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {copyStatus === 'copied'
                ? 'Secret copied to the clipboard.'
                : copyStatus === 'error'
                  ? 'Automatic copy failed. Select the secret above and copy it manually.'
                  : 'This is the only time DevFathom will show this secret.'}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setOneTimeSecret(null);
                setOneTimeDeviceName(null);
                setCopyStatus('idle');
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
