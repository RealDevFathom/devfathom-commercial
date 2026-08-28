'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { inferRouterOutputs } from '@trpc/server';
import { Copy } from 'lucide-react';
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
  const restaurantModule = entitlements.modules.find((module) => module.key === 'restaurant-core');
  const restaurantEnabled =
    restaurantModule?.enabled ?? entitlements.enabledModules.includes('restaurant-core');
  const camerasEnabled = entitlements.enabledModules.includes('restaurant-integrations');
  const utils = trpc.useUtils();
  const devicesQuery = trpc.restaurantDevices.list.useQuery(undefined, {
    enabled: restaurantEnabled,
    refetchInterval: 60_000,
  });
  const staffQuery = trpc.restaurantStaff.list.useQuery(undefined, { enabled: restaurantEnabled });

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [revealedEnrollment, setRevealedEnrollment] = useState<{
    deviceName: string;
    secret: string;
  } | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [coAuthError, setCoAuthError] = useState('');

  const refreshDevices = () => void utils.restaurantDevices.list.invalidate();
  const enrollment = trpc.restaurantDevices.initiateEnrollment.useMutation({
    onSuccess: (result) => {
      setEnrollOpen(false);
      setRevealedEnrollment({ deviceName: result.device.name, secret: result.enrollmentSecret });
      refreshDevices();
      toast.success('Device enrolled. Copy its secret now.');
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

  const branches = useMemo(() => {
    const values = new Map<string, string>();
    for (const device of devicesQuery.data ?? []) values.set(device.branch.id, device.branch.name);
    for (const staff of staffQuery.data ?? []) {
      if (staff.primaryBranch) values.set(staff.primaryBranch.id, staff.primaryBranch.name);
    }
    return [...values.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [devicesQuery.data, staffQuery.data]);
  const activeStaff = useMemo(
    () => (staffQuery.data ?? []).filter((staff) => staff.status === 'ACTIVE'),
    [staffQuery.data]
  );

  const permissionDenied = isPermissionError(devicesQuery.error);
  const closeEnrollmentSecret = () => {
    setRevealedEnrollment(null);
    enrollment.reset();
  };

  const submitEnrollment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = { name: formText(data, 'name'), branchId: formText(data, 'branchId') };
    enrollment.mutate(input, { onSuccess: () => form.reset() });
  };

  const submitRevocation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedDevice) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const actingStaffProfileId = formText(data, 'actingStaffProfileId');
    const approvingStaffProfileId = formText(data, 'approvingStaffProfileId');
    const approvingSecret = formText(data, 'approvingSecret');
    const approvingType = formText(data, 'approvingType') as 'PIN' | 'BADGE';
    const reason = formText(data, 'reason');
    const secretInput = form.elements.namedItem('approvingSecret');
    if (secretInput instanceof HTMLInputElement) secretInput.value = '';
    setCoAuthError('');

    if (actingStaffProfileId === approvingStaffProfileId) {
      setCoAuthError('Acting and approving staff must be different active people.');
      return;
    }

    revokeDevice.mutate(
      {
        deviceId: selectedDevice.id,
        actingStaffProfileId,
        approvingStaffProfileId,
        approvingType,
        approvingSecret,
        reason,
      },
      { onSettled: () => revokeDevice.reset() }
    );
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
              {camerasEnabled ? (
                <Link
                  className={buttonVariants({ variant: 'secondary' })}
                  href="/restaurant/integrations/cameras"
                >
                  Cameras →
                </Link>
              ) : null}
              <Button
                className="min-h-11"
                onClick={() => {
                  enrollment.reset();
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
        >
          {staffQuery.error ? (
            <div
              role="alert"
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-warning/10 p-3 text-sm text-warning"
            >
              <span>Staff approvers could not be loaded. Device revocation is unavailable.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void staffQuery.refetch()}
              >
                Retry approvers
              </Button>
            </div>
          ) : null}

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
                      <span className="block font-mono text-[0.6875rem] text-text-faint">
                        {device.id}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="block text-text-strong">{device.branch.name}</span>
                      <span className="block font-mono text-[0.6875rem] text-text-faint">
                        {device.branch.id}
                      </span>
                    </TableCell>
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
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={staffQuery.isLoading || Boolean(staffQuery.error)}
                          onClick={() => {
                            setCoAuthError('');
                            setSelectedDevice(device);
                          }}
                        >
                          Revoke {device.name}
                        </Button>
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

      <Dialog
        open={enrollOpen}
        onOpenChange={(open) => {
          if (!enrollment.isPending) setEnrollOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enroll restaurant device</DialogTitle>
            <DialogDescription>
              Assign a terminal to a branch. Any valid branch ID is accepted.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submitEnrollment}>
            {enrollment.error ? (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {enrollment.error.message}
              </p>
            ) : null}
            <label className="space-y-1.5">
              <span className={labelClass}>Device name</span>
              <Input name="name" required maxLength={120} className="h-11" />
            </label>
            <div className="space-y-1.5">
              <label htmlFor="device-branch-id" className={labelClass}>
                Branch ID
              </label>
              <Input
                id="device-branch-id"
                name="branchId"
                required
                list="device-branch-options"
                className="h-11"
              />
              <datalist id="device-branch-options">
                {branches.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </datalist>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={enrollment.isPending}
                onClick={() => setEnrollOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" className="min-h-11" disabled={enrollment.isPending}>
                {enrollment.isPending ? 'Enrolling…' : 'Enroll'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revealedEnrollment != null}
        disablePointerDismissal
        onOpenChange={() => undefined}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Save the enrollment secret</DialogTitle>
            <DialogDescription>
              This is the only time the secret for {revealedEnrollment?.deviceName} will be shown.
            </DialogDescription>
          </DialogHeader>
          <code className="break-all rounded-md border border-border-default bg-surface-sunken p-4 font-mono text-sm text-text-strong">
            {revealedEnrollment?.secret}
          </code>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                const secret = revealedEnrollment?.secret;
                if (!secret) return;
                void navigator.clipboard
                  .writeText(secret)
                  .then(() => toast.success('Enrollment secret copied.'))
                  .catch(() => toast.error('Enrollment secret could not be copied.'));
              }}
            >
              <Copy />
              Copy
            </Button>
            <Button
              type="button"
              aria-label="Close enrollment secret"
              className="min-h-11"
              onClick={closeEnrollmentSecret}
            >
              I saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedDevice != null}
        onOpenChange={(open) => {
          if (!open && !revokeDevice.isPending) {
            setSelectedDevice(null);
            setCoAuthError('');
            revokeDevice.reset();
          }
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Revoke {selectedDevice?.name}?</DialogTitle>
            <DialogDescription>
              Revocation is immediate and requires a distinct active staff approver.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submitRevocation}>
            {coAuthError ? (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {coAuthError}
              </p>
            ) : null}
            {activeStaff.length < 2 ? (
              <p role="alert" className="rounded-md bg-warning/10 p-3 text-sm text-warning">
                At least two active restaurant staff profiles are required.
              </p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className={labelClass}>Acting staff</span>
                <select
                  name="actingStaffProfileId"
                  required
                  defaultValue=""
                  className={selectClass}
                >
                  <option value="" disabled>
                    Select acting staff
                  </option>
                  {activeStaff.map((staff) => (
                    <option key={staff.id} value={staff.id}>
                      {staff.displayName}
                    </option>
                  ))}
                </select>
              </label>
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
                  {activeStaff.map((staff) => (
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
                disabled={revokeDevice.isPending}
                onClick={() => {
                  setSelectedDevice(null);
                  setCoAuthError('');
                  revokeDevice.reset();
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                className="min-h-11"
                disabled={revokeDevice.isPending || activeStaff.length < 2}
              >
                {revokeDevice.isPending ? 'Revoking…' : 'Confirm revocation'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
