'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
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
import { StaffJobRolesDialog } from '@/components/restaurant/staff-job-roles-dialog';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';
import { RestaurantBranchSelect } from './restaurant-branch-select';
import { RestaurantDeviceSelect } from './restaurant-device-select';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type StaffProfile = RouterOutputs['restaurantStaff']['list'][number];
type StaffStatus = StaffProfile['status'];
type Credential = RouterOutputs['restaurantStaff']['listCredentials'][number];
type UiError = { message: string; data?: { code?: string } | null };

const statuses: StaffStatus[] = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'];
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

function StaffTableSkeleton() {
  return (
    <div role="status" aria-label="Loading restaurant staff" className="space-y-3 py-2">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function RestaurantStaffConsole() {
  const entitlements = useEntitlements();
  const restaurantModule = entitlements.modules.find((module) => module.key === 'restaurant-core');
  const restaurantEnabled =
    restaurantModule?.enabled ?? entitlements.enabledModules.includes('restaurant-core');
  const utils = trpc.useUtils();
  const staffQuery = trpc.restaurantStaff.list.useQuery(undefined, { enabled: restaurantEnabled });
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: restaurantEnabled,
  });
  const devicesQuery = trpc.restaurantDevices.list.useQuery(undefined, {
    enabled: restaurantEnabled,
  });

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | StaffStatus>('ALL');
  const [branchFilter, setBranchFilter] = useState('');
  const [staffFormOpen, setStaffFormOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<{
    inviteUrl: string;
    emailDelivered: boolean;
  } | null>(null);
  const [createMode, setCreateMode] = useState<'INVITE' | 'LINK'>('INVITE');
  const [editingStaff, setEditingStaff] = useState<StaffProfile | null>(null);
  const [selectedStaff, setSelectedStaff] = useState<StaffProfile | null>(null);
  // SOP-1: the job-role multi-select target (separate from the credentials dialog).
  const [jobRolesStaff, setJobRolesStaff] = useState<StaffProfile | null>(null);
  const [credentialError, setCredentialError] = useState('');
  const [revokeCredential, setRevokeCredential] = useState<Pick<Credential, 'id' | 'type'> | null>(
    null
  );
  const eligibleUsersQuery = trpc.restaurantStaff.listEligibleUsers.useQuery(undefined, {
    enabled: restaurantEnabled && staffFormOpen,
  });

  const credentialsQuery = trpc.restaurantStaff.listCredentials.useQuery(
    { staffProfileId: selectedStaff?.id ?? '', includeRevoked: true },
    { enabled: restaurantEnabled && selectedStaff != null }
  );

  const refreshStaff = () => void utils.restaurantStaff.list.invalidate();
  const refreshCredentials = () => {
    if (selectedStaff) {
      void utils.restaurantStaff.listCredentials.invalidate({
        staffProfileId: selectedStaff.id,
        includeRevoked: true,
      });
    }
  };
  const mutationFailure = (error: { message: string }) => toast.error(error.message);

  const createStaff = trpc.restaurantStaff.create.useMutation({
    onSuccess: () => {
      refreshStaff();
      setStaffFormOpen(false);
      toast.success('Staff profile created.');
    },
    onError: mutationFailure,
  });
  const inviteStaff = trpc.restaurantStaff.invite.useMutation({
    onSuccess: (result) => {
      refreshStaff();
      void utils.restaurantStaff.listEligibleUsers.invalidate();
      setInviteResult(result);
      toast.success(
        result.emailDelivered
          ? 'Invitation created and email send accepted.'
          : 'Invitation created, but email delivery could not be confirmed.'
      );
    },
    onError: mutationFailure,
  });
  const updateStaff = trpc.restaurantStaff.update.useMutation({
    onSuccess: () => {
      refreshStaff();
      setStaffFormOpen(false);
      toast.success('Staff profile updated.');
    },
    onError: mutationFailure,
  });
  const setStatus = trpc.restaurantStaff.setStatus.useMutation({
    onSuccess: () => {
      refreshStaff();
      toast.success('Staff status updated.');
    },
    onError: mutationFailure,
  });
  const issueCredential = trpc.restaurantStaff.issueCredential.useMutation({
    onSuccess: () => {
      setCredentialError('');
      refreshCredentials();
      toast.success('Credential issued.');
    },
    onError: (error) => {
      setCredentialError(error.message);
      toast.error(error.message);
    },
  });
  const rotateCredential = trpc.restaurantStaff.rotateCredential.useMutation({
    onSuccess: () => {
      setCredentialError('');
      refreshCredentials();
      toast.success('Credential rotated.');
    },
    onError: (error) => {
      setCredentialError(error.message);
      toast.error(error.message);
    },
  });
  const revokeCredentialMutation = trpc.restaurantStaff.revokeCredential.useMutation({
    onSuccess: () => {
      setRevokeCredential(null);
      refreshCredentials();
      toast.success('Credential revoked.');
    },
    onError: mutationFailure,
  });

  const branches = branchesQuery.data ?? [];

  const filteredStaff = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const branchNeedle = branchFilter.trim().toLowerCase();
    return (staffQuery.data ?? []).filter((staff) => {
      const matchesSearch =
        needle.length === 0 ||
        staff.displayName.toLowerCase().includes(needle) ||
        staff.email?.toLowerCase().includes(needle);
      const matchesStatus = statusFilter === 'ALL' || staff.status === statusFilter;
      const matchesBranch =
        branchNeedle.length === 0 ||
        staff.primaryBranchId?.toLowerCase().includes(branchNeedle) ||
        staff.primaryBranch?.name.toLowerCase().includes(branchNeedle);
      return matchesSearch && matchesStatus && matchesBranch;
    });
  }, [branchFilter, search, staffQuery.data, statusFilter]);

  const permissionDenied = isPermissionError(staffQuery.error);
  const staffFormPending = createStaff.isPending || inviteStaff.isPending || updateStaff.isPending;
  const credentialsPending = issueCredential.isPending || rotateCredential.isPending;

  const openCreate = () => {
    setEditingStaff(null);
    setInviteResult(null);
    setCreateMode('INVITE');
    createStaff.reset();
    inviteStaff.reset();
    updateStaff.reset();
    setStaffFormOpen(true);
  };

  const openEdit = (staff: StaffProfile) => {
    setEditingStaff(staff);
    setInviteResult(null);
    createStaff.reset();
    inviteStaff.reset();
    updateStaff.reset();
    setStaffFormOpen(true);
  };

  const submitStaff = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const userId = data.has('userId')
      ? formText(data, 'userId') || null
      : (editingStaff?.userId ?? null);
    const payload = {
      displayName: formText(data, 'displayName'),
      email: formText(data, 'email') || null,
      // An unchanged pending account need not pass the ACTIVE-only link check.
      ...(editingStaff && userId === editingStaff.userId ? {} : { userId }),
      primaryBranchId: formText(data, 'primaryBranchId') || null,
      status: formText(data, 'status') as StaffStatus,
    };
    if (editingStaff) updateStaff.mutate({ id: editingStaff.id, ...payload });
    else if (createMode === 'INVITE') {
      const primaryBranchId = payload.primaryBranchId;
      if (!primaryBranchId) {
        toast.error('Select a primary branch before sending the invitation.');
        return;
      }
      inviteStaff.mutate({
        name: payload.displayName,
        email: formText(data, 'email'),
        staffRole: formText(data, 'staffRole') as 'WAITER' | 'MANAGER',
        status: payload.status,
        primaryBranchId,
        idempotencyKey: crypto.randomUUID(),
      });
    } else createStaff.mutate(payload);
  };

  const submitCredential = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedStaff) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const secret = formText(data, 'secret');
    const type = formText(data, 'type') as 'PIN' | 'BADGE';
    const deviceId = formText(data, 'deviceId') || null;
    const secretInput = form.elements.namedItem('secret');
    if (secretInput instanceof HTMLInputElement) secretInput.value = '';
    setCredentialError('');
    issueCredential.mutate(
      { staffProfileId: selectedStaff.id, type, secret, deviceId },
      {
        onSuccess: () => form.reset(),
        onSettled: () => issueCredential.reset(),
      }
    );
  };

  const submitRotation = (event: FormEvent<HTMLFormElement>, credentialId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const secret = formText(new FormData(form), 'secret');
    form.reset();
    setCredentialError('');
    rotateCredential.mutate(
      { credentialId, secret },
      { onSettled: () => rotateCredential.reset() }
    );
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Staff"
        description="Manage restaurant staff profiles, access status, and operator credentials."
        actions={
          restaurantEnabled && !permissionDenied ? (
            <Button className="min-h-11" onClick={openCreate}>
              Add staff member
            </Button>
          ) : null
        }
      />

      {!restaurantEnabled ? (
        <SectionCard title="Restaurant module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Restaurant staff tools are unavailable for this organization. Enable Restaurant Core
              to load staff data or manage credentials.
            </p>
          </div>
        </SectionCard>
      ) : permissionDenied ? (
        <SectionCard title="Staff access unavailable">
          <p role="alert" className="text-sm text-destructive">
            You do not have permission to manage restaurant staff.
          </p>
        </SectionCard>
      ) : (
        <SectionCard>
          <div className="mb-4 space-y-1">
            <Eyebrow>Directory</Eyebrow>
            <h2 className="font-display text-lg leading-snug font-semibold tracking-tight text-text-strong">
              {staffQuery.isLoading
                ? 'Loading staff…'
                : `${filteredStaff.length} staff member${filteredStaff.length === 1 ? '' : 's'}`}
            </h2>
          </div>
          <div className="mb-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_14rem]">
            <label className="space-y-1.5">
              <span className={labelClass}>Search name or email</span>
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search staff"
                className="h-11"
              />
            </label>
            <label className="space-y-1.5">
              <span className={labelClass}>Status</span>
              <select
                className={selectClass}
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as 'ALL' | StaffStatus)}
              >
                <option value="ALL">All statuses</option>
                {statuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-1.5">
              <label htmlFor="staff-branch-filter" className={labelClass}>
                Branch
              </label>
              <RestaurantBranchSelect
                id="staff-branch-filter"
                branches={branches}
                loading={branchesQuery.isLoading}
                error={Boolean(branchesQuery.error)}
                value={branchFilter}
                onChange={setBranchFilter}
                allowEmpty
                emptyLabel="All branches"
              />
            </div>
          </div>

          {staffQuery.isLoading ? (
            <StaffTableSkeleton />
          ) : staffQuery.error ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/10 p-4 text-sm text-destructive"
            >
              <span>Staff could not be loaded.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void staffQuery.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : filteredStaff.length === 0 ? (
            <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
              <p className="font-medium text-text-strong">No staff match these filters.</p>
              <p className="mt-1 text-sm text-text-muted">
                Clear the filters or add the first restaurant staff profile.
              </p>
            </div>
          ) : (
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredStaff.map((staff) => (
                  <TableRow key={staff.id}>
                    <TableCell className="font-medium text-text-strong">
                      {staff.displayName}
                    </TableCell>
                    <TableCell className="text-text-muted">{staff.email ?? '—'}</TableCell>
                    <TableCell>
                      <span className="block text-text-strong">
                        {staff.primaryBranch?.name ?? 'Unassigned'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <select
                        aria-label={`Status for ${staff.displayName}`}
                        className="h-8 rounded-md border border-input bg-surface-raised px-2 text-xs text-text-strong outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                        value={staff.status}
                        disabled={setStatus.isPending}
                        onChange={(event) =>
                          setStatus.mutate({
                            id: staff.id,
                            status: event.target.value as StaffStatus,
                          })
                        }
                      >
                        {statuses.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell className="text-text-muted">
                      {dateFormat.format(new Date(staff.createdAt))}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => openEdit(staff)}>
                          Edit
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setJobRolesStaff(staff)}>
                          Job roles
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setCredentialError('');
                            setSelectedStaff(staff);
                          }}
                        >
                          Credentials
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      )}

      {/* Mounted only while open, so closing resets its draft state with no effect. */}
      {jobRolesStaff ? (
        <StaffJobRolesDialog
          open
          onOpenChange={(open) => {
            if (!open) setJobRolesStaff(null);
          }}
          staffProfileId={jobRolesStaff.id}
          staffDisplayName={jobRolesStaff.displayName}
          defaultBranchId={jobRolesStaff.primaryBranchId}
          defaultBranchName={jobRolesStaff.primaryBranch?.name}
        />
      ) : null}

      <Dialog
        open={staffFormOpen}
        onOpenChange={(open) => {
          if (!staffFormPending) setStaffFormOpen(open);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingStaff ? 'Edit staff member' : 'Add staff member'}</DialogTitle>
            <DialogDescription>
              Profile details control restaurant access and branch assignment.
            </DialogDescription>
          </DialogHeader>
          <form
            key={editingStaff?.id ?? 'new-staff'}
            className="space-y-4"
            onSubmit={submitStaff}
            onChange={() => setInviteResult(null)}
          >
            {inviteResult ? (
              <div role="status" className="rounded-md border border-border bg-surface p-3 text-sm">
                <p className="font-medium text-text-strong">
                  {inviteResult.emailDelivered
                    ? 'The email send was accepted, but delivery is not guaranteed.'
                    : 'Email delivery could not be confirmed.'}
                </p>
                <p className="mt-1 text-text-muted">Copy and share this invitation link:</p>
                <a
                  className="mt-1 block break-all text-primary underline underline-offset-4"
                  href={inviteResult.inviteUrl}
                >
                  {inviteResult.inviteUrl}
                </a>
              </div>
            ) : null}
            {(createStaff.error || inviteStaff.error || updateStaff.error) && (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {(createStaff.error ?? inviteStaff.error ?? updateStaff.error)?.message}
              </p>
            )}
            {!editingStaff ? (
              <div className="grid grid-cols-2 gap-2" aria-label="How to add staff">
                <Button
                  type="button"
                  variant={createMode === 'INVITE' ? 'secondary' : 'outline'}
                  aria-pressed={createMode === 'INVITE'}
                  disabled={staffFormPending}
                  onClick={() => {
                    setInviteResult(null);
                    setCreateMode('INVITE');
                  }}
                >
                  Invite new user
                </Button>
                <Button
                  type="button"
                  variant={createMode === 'LINK' ? 'secondary' : 'outline'}
                  aria-pressed={createMode === 'LINK'}
                  disabled={staffFormPending}
                  onClick={() => {
                    setInviteResult(null);
                    setCreateMode('LINK');
                  }}
                >
                  Link existing user
                </Button>
              </div>
            ) : null}
            <label className="space-y-1.5">
              <span className={labelClass}>Display name</span>
              <Input
                name="displayName"
                disabled={staffFormPending}
                defaultValue={editingStaff?.displayName}
                required
                maxLength={200}
                className="h-11"
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className={labelClass}>Email</span>
                <Input
                  name="email"
                  disabled={staffFormPending}
                  type="email"
                  defaultValue={editingStaff?.email ?? ''}
                  required={!editingStaff && createMode === 'INVITE'}
                  className="h-11"
                />
              </label>
              {!editingStaff && createMode === 'INVITE' ? (
                <label className="space-y-1.5">
                  <span className={labelClass}>Staff role</span>
                  <select
                    name="staffRole"
                    defaultValue="WAITER"
                    className={selectClass}
                    disabled={staffFormPending}
                  >
                    <option value="WAITER">Waiter</option>
                    <option value="MANAGER">Manager</option>
                  </select>
                </label>
              ) : (
                <div className="space-y-1.5">
                  <label htmlFor="staff-organization-user" className={labelClass}>
                    Organization user
                  </label>
                  <select
                    id="staff-organization-user"
                    name="userId"
                    defaultValue={editingStaff?.userId ?? ''}
                    className={selectClass}
                    disabled={
                      staffFormPending ||
                      eligibleUsersQuery.isLoading ||
                      Boolean(eligibleUsersQuery.error)
                    }
                    aria-describedby="staff-user-help"
                  >
                    <option value="">
                      {eligibleUsersQuery.isLoading
                        ? 'Loading available users…'
                        : eligibleUsersQuery.error
                          ? isPermissionError(eligibleUsersQuery.error)
                            ? 'User directory unavailable for your access'
                            : 'User directory unavailable'
                          : 'No linked organization user'}
                    </option>
                    {editingStaff?.userId ? (
                      <option value={editingStaff.userId}>
                        {editingStaff.displayName} — currently linked
                      </option>
                    ) : null}
                    {(eligibleUsersQuery.data ?? []).map((user) => {
                      if (user.id === editingStaff?.userId) return null;
                      const linkedProfile = user.restaurantStaffProfiles[0];
                      const unavailable = user.status !== 'ACTIVE' || Boolean(linkedProfile);
                      const state =
                        user.status !== 'ACTIVE'
                          ? ' — inactive'
                          : linkedProfile
                            ? ` — linked to ${linkedProfile.displayName}`
                            : '';
                      return (
                        <option key={user.id} value={user.id} disabled={unavailable}>
                          {user.name} — {user.email}
                          {state}
                        </option>
                      );
                    })}
                  </select>
                  <span id="staff-user-help" className="block text-xs text-text-muted">
                    {eligibleUsersQuery.data?.every(
                      (user) =>
                        user.status !== 'ACTIVE' ||
                        (user.restaurantStaffProfiles.length > 0 &&
                          user.id !== editingStaff?.userId)
                    )
                      ? 'No active, unlinked organization users are available.'
                      : 'Unavailable users remain visible for context but cannot be selected.'}
                  </span>
                </div>
              )}
              <div className="space-y-1.5">
                <label htmlFor="staff-primary-branch" className={labelClass}>
                  Primary branch
                </label>
                <RestaurantBranchSelect
                  id="staff-primary-branch"
                  disabled={staffFormPending}
                  name="primaryBranchId"
                  defaultValue={editingStaff?.primaryBranchId ?? ''}
                  branches={branches}
                  loading={branchesQuery.isLoading}
                  error={Boolean(branchesQuery.error)}
                  required={editingStaff === null && createMode === 'INVITE'}
                  allowEmpty={editingStaff !== null || createMode !== 'INVITE'}
                  emptyLabel="No primary branch"
                />
              </div>
              <label className="space-y-1.5">
                <span className={labelClass}>Status</span>
                <select
                  name="status"
                  disabled={staffFormPending}
                  defaultValue={editingStaff?.status ?? 'ACTIVE'}
                  className={selectClass}
                >
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={staffFormPending}
                onClick={() => setStaffFormOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" className="min-h-11" disabled={staffFormPending}>
                {staffFormPending ? 'Saving…' : 'Save staff member'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedStaff != null}
        onOpenChange={(open) => {
          if (!open && !credentialsPending) {
            setSelectedStaff(null);
            setRevokeCredential(null);
            setCredentialError('');
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedStaff?.displayName} credentials</DialogTitle>
            <DialogDescription>
              Issue, rotate, or revoke PIN and badge credentials. Secrets are never shown here.
            </DialogDescription>
          </DialogHeader>

          {credentialError ? (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {credentialError}
            </p>
          ) : null}

          <form
            className="grid gap-3 rounded-md bg-surface-sunken p-4 sm:grid-cols-2"
            onSubmit={submitCredential}
          >
            <label className="space-y-1.5">
              <span className={labelClass}>Credential type</span>
              <select name="type" className={selectClass} defaultValue="PIN">
                <option value="PIN">PIN</option>
                <option value="BADGE">Badge</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className={labelClass}>Device restriction (optional)</span>
              <RestaurantDeviceSelect
                devices={devicesQuery.data ?? []}
                branchId={selectedStaff?.primaryBranch?.id}
                loading={devicesQuery.isLoading}
                error={Boolean(devicesQuery.error)}
                allowEmpty
                label="Device restriction"
              />
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className={labelClass}>New operator secret</span>
              <Input
                name="secret"
                type="password"
                required
                aria-invalid={credentialError ? true : undefined}
                autoComplete="new-password"
                className="h-11"
              />
            </label>
            <Button type="submit" className="min-h-11 sm:col-span-2" disabled={credentialsPending}>
              {issueCredential.isPending ? 'Issuing…' : 'Issue credential'}
            </Button>
          </form>

          {credentialsQuery.isLoading ? (
            <div role="status" aria-label="Loading credentials" className="space-y-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : credentialsQuery.error ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            >
              <span>
                {isPermissionError(credentialsQuery.error)
                  ? 'You do not have permission to view operator credentials.'
                  : 'Credentials could not be loaded.'}
              </span>
              {!isPermissionError(credentialsQuery.error) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void credentialsQuery.refetch()}
                >
                  Try again
                </Button>
              ) : null}
            </div>
          ) : credentialsQuery.data?.length ? (
            <div className="space-y-3">
              {credentialsQuery.data.map((credential) => {
                const credentialStatus = credential.revokedAt
                  ? 'REVOKED'
                  : credential.lockedUntil && new Date(credential.lockedUntil) > new Date()
                    ? 'LOCKED'
                    : 'ACTIVE';
                return (
                  <div key={credential.id} className="rounded-md border border-border-subtle p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-text-strong">{credential.type}</span>
                          <StatusPill
                            status={credentialStatus}
                            tone={
                              credentialStatus === 'ACTIVE'
                                ? 'success'
                                : credentialStatus === 'LOCKED'
                                  ? 'warning'
                                  : 'danger'
                            }
                          />
                        </div>
                        <p className="text-xs text-text-muted">
                          Failed attempts: {credential.failedAttempts}
                          {credential.deviceId
                            ? ` · ${devicesQuery.data?.find((device) => device.id === credential.deviceId)?.name ?? 'Device name unavailable'}`
                            : ''}
                        </p>
                      </div>
                      {!credential.revokedAt ? (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={revokeCredentialMutation.isPending}
                          onClick={() => {
                            revokeCredentialMutation.reset();
                            setRevokeCredential({ id: credential.id, type: credential.type });
                          }}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                    {!credential.revokedAt ? (
                      <form
                        className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                        onSubmit={(event) => submitRotation(event, credential.id)}
                      >
                        <label className="space-y-1.5">
                          <span className={labelClass}>Replacement {credential.type} secret</span>
                          <Input
                            name="secret"
                            type="password"
                            required
                            aria-invalid={credentialError ? true : undefined}
                            autoComplete="new-password"
                            className="h-11"
                          />
                        </label>
                        <Button
                          type="submit"
                          variant="outline"
                          className="min-h-11"
                          disabled={credentialsPending}
                        >
                          {rotateCredential.isPending ? 'Rotating…' : 'Rotate'}
                        </Button>
                      </form>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border-default p-6 text-center">
              <p className="font-medium text-text-strong">No credentials issued.</p>
              <p className="mt-1 text-sm text-text-muted">Use the form above to issue one.</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeCredential != null}
        onOpenChange={(open) => {
          if (!open && !revokeCredentialMutation.isPending) setRevokeCredential(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Revoke {revokeCredential?.type} credential?</DialogTitle>
            <DialogDescription>
              This credential will stop authenticating immediately. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {revokeCredentialMutation.error ? (
            <p role="alert" className="text-sm text-destructive">
              {revokeCredentialMutation.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={revokeCredentialMutation.isPending}
              onClick={() => setRevokeCredential(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={revokeCredentialMutation.isPending}
              onClick={() => {
                if (revokeCredential) {
                  revokeCredentialMutation.mutate({ credentialId: revokeCredential.id });
                }
              }}
            >
              {revokeCredentialMutation.isPending ? 'Revoking…' : 'Revoke credential'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
