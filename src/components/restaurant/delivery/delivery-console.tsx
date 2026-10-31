'use client';

import { useState, type FormEvent } from 'react';
import { inferRouterOutputs } from '@trpc/server';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type Outputs = inferRouterOutputs<AppRouter>;
type Zone = Outputs['restaurantDelivery']['listZones'][number];
type Address = Outputs['restaurantDelivery']['listAddresses'][number];
type Editor = { kind: 'zone'; item?: Zone } | { kind: 'address'; item?: Address };
type Confirmation =
  | { kind: 'deactivate-zone'; item: Zone }
  | { kind: 'reactivate-zone'; item: Zone }
  | { kind: 'address'; item: Address };

const inputClass =
  'min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50';
const labelClass =
  'font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

function value(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim();
}

function optional(data: FormData, key: string) {
  return value(data, key) || null;
}

function denied(error: { data?: { code?: string } | null } | null | undefined) {
  return error?.data?.code === 'FORBIDDEN' || error?.data?.code === 'UNAUTHORIZED';
}

function QueryState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error?: { message: string; data?: { code?: string } | null } | null;
  onRetry: () => void;
}) {
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-5">
      <p className="font-medium text-text-strong">
        {denied(error) ? 'Permission denied' : 'Delivery data is unavailable'}
      </p>
      <p className="mt-1 text-sm text-text-muted">{error.message}</p>
      {!denied(error) ? (
        <Button className="mt-4" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function DeliveryConsole() {
  const entitlements = useEntitlements();
  const moduleView = entitlements.modules.find((module) => module.key === 'restaurant-core');
  const moduleEnabled =
    moduleView?.enabled ?? entitlements.enabledModules.includes('restaurant-core');
  const utils = trpc.useUtils();
  const [branchId, setBranchId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [mutationError, setMutationError] = useState('');

  const branches = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: moduleEnabled,
  });
  const customers = trpc.restaurantDelivery.listCustomers.useQuery(
    { ...(customerSearch.trim() ? { query: customerSearch.trim() } : {}), limit: 100 },
    { enabled: moduleEnabled }
  );
  const zones = trpc.restaurantDelivery.listZones.useQuery(
    { branchId },
    { enabled: moduleEnabled && Boolean(branchId) }
  );
  const addresses = trpc.restaurantDelivery.listAddresses.useQuery(
    { customerId },
    { enabled: moduleEnabled && Boolean(customerId) }
  );

  const succeed = (message: string) => {
    setEditor(null);
    setConfirmation(null);
    setMutationError('');
    void utils.restaurantDelivery.listZones.invalidate();
    void utils.restaurantDelivery.listAddresses.invalidate();
    toast.success(message);
  };
  const fail = (error: { message: string }) => {
    setMutationError(error.message);
    toast.error(error.message);
  };
  const options = (message: string) => ({ onSuccess: () => succeed(message), onError: fail });
  const createZone = trpc.restaurantDelivery.createZone.useMutation(
    options('Delivery zone created.')
  );
  const updateZone = trpc.restaurantDelivery.updateZone.useMutation(
    options('Delivery zone updated.')
  );
  const deactivateZone = trpc.restaurantDelivery.deactivateZone.useMutation(
    options('Delivery zone deactivated.')
  );
  const reactivateZone = trpc.restaurantDelivery.reactivateZone.useMutation(
    options('Delivery zone reactivated.')
  );
  const createAddress = trpc.restaurantDelivery.createAddress.useMutation(
    options('Saved address created.')
  );
  const updateAddress = trpc.restaurantDelivery.updateAddress.useMutation(
    options('Saved address updated.')
  );
  const setDefaultAddress = trpc.restaurantDelivery.setDefaultAddress.useMutation({
    onSuccess: () => {
      void utils.restaurantDelivery.listAddresses.invalidate();
      toast.success('Default address updated.');
    },
    onError: fail,
  });
  const deleteAddress = trpc.restaurantDelivery.deleteAddress.useMutation(
    options('Saved address deactivated.')
  );
  const busy = [
    createZone,
    updateZone,
    deactivateZone,
    reactivateZone,
    createAddress,
    updateAddress,
    setDefaultAddress,
    deleteAddress,
  ].some((mutation) => mutation.isPending);

  const submitZone = (event: FormEvent<HTMLFormElement>, item?: Zone) => {
    event.preventDefault();
    setMutationError('');
    const data = new FormData(event.currentTarget);
    const payload = {
      branchId,
      name: value(data, 'name'),
      fixedFee: value(data, 'fixedFee'),
      minimumSubtotal: value(data, 'minimumSubtotal') || undefined,
      promisedMinutes: Number(value(data, 'promisedMinutes')),
      sortOrder: Number(value(data, 'sortOrder') || 0),
      areaPostalLabel: optional(data, 'areaPostalLabel'),
    };
    if (item) updateZone.mutate({ ...payload, zoneId: item.id });
    else createZone.mutate(payload);
  };

  const submitAddress = (event: FormEvent<HTMLFormElement>, item?: Address) => {
    event.preventDefault();
    setMutationError('');
    const data = new FormData(event.currentTarget);
    const payload = {
      customerId,
      label: value(data, 'label'),
      recipientName: value(data, 'recipientName'),
      phone: value(data, 'phone'),
      addressLine1: value(data, 'addressLine1'),
      addressLine2: optional(data, 'addressLine2'),
      locality: value(data, 'locality'),
      administrativeArea: optional(data, 'administrativeArea'),
      postalCode: optional(data, 'postalCode'),
      countryCode: value(data, 'countryCode').toUpperCase(),
      isDefault: data.get('isDefault') === 'on',
    };
    if (item) updateAddress.mutate({ ...payload, addressId: item.id });
    else createAddress.mutate(payload);
  };

  if (!moduleEnabled) {
    return (
      <div className="min-w-0">
        <PageHeader
          eyebrow="Restaurant operations"
          heading="Delivery"
          description="Branch delivery zones and customer delivery addresses."
        />
        <SectionCard title="Restaurant Core module disabled">
          <p className="text-sm text-text-muted">
            Delivery administration requires the Restaurant Core entitlement. No delivery or
            customer data has been requested.
          </p>
        </SectionCard>
      </div>
    );
  }

  const customerRows = customers.data?.customers ?? [];
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Delivery"
        description="Configure branch service areas and manage saved addresses for one deliberately selected customer."
      />

      <SectionCard title="Scope" titleLevel={2}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Branch">
            <select
              className={inputClass}
              value={branchId}
              onChange={(event) => {
                setBranchId(event.target.value);
                setEditor(null);
              }}
              disabled={branches.isLoading || Boolean(branches.error)}
            >
              <option value="">Select a branch</option>
              {(branches.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                  {branch.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </Field>
          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="delivery-customer-search">
              Find customer
            </label>
            <input
              id="delivery-customer-search"
              className={inputClass}
              value={customerSearch}
              onChange={(event) => setCustomerSearch(event.target.value)}
              placeholder="Search by customer name"
            />
            <label className="sr-only" htmlFor="delivery-customer">
              Customer
            </label>
            <select
              id="delivery-customer"
              className={inputClass}
              value={customerId}
              onChange={(event) => {
                setCustomerId(event.target.value);
                setEditor(null);
              }}
              disabled={customers.isLoading || Boolean(customers.error)}
            >
              <option value="">Select a customer</option>
              {customerRows.map((customer, index) => (
                <option key={customer.id} value={customer.id}>
                  {customer.displayName ||
                    [customer.givenName, customer.familyName].filter(Boolean).join(' ') ||
                    `Unnamed customer ${index + 1}`}
                </option>
              ))}
            </select>
          </div>
        </div>
        <QueryState
          loading={branches.isLoading || customers.isLoading}
          error={branches.error ?? customers.error}
          onRetry={() => {
            void branches.refetch();
            void customers.refetch();
          }}
        />
      </SectionCard>

      <div className="grid min-w-0 gap-6 xl:grid-cols-2">
        <SectionCard
          title="Delivery zones"
          titleLevel={2}
          actions={
            <Button disabled={!branchId} onClick={() => setEditor({ kind: 'zone' })}>
              <Plus /> Add zone
            </Button>
          }
        >
          {!branchId ? (
            <EmptyState text="Select a branch to load its delivery zones." />
          ) : (
            <QueryState
              loading={zones.isLoading}
              error={zones.error}
              onRetry={() => void zones.refetch()}
            />
          )}
          {branchId && !zones.isLoading && !zones.error && (zones.data?.length ?? 0) === 0 ? (
            <EmptyState text="This branch has no delivery zones yet." />
          ) : null}
          {zones.data?.length ? (
            <div className="overflow-x-auto rounded-md border border-border-subtle">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="bg-surface-sunken font-mono text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="p-3">Zone</th>
                    <th className="p-3">Fee / minimum</th>
                    <th className="p-3">Promise</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {zones.data.map((zone) => (
                    <tr
                      key={zone.id}
                      className="border-t border-border-subtle align-top hover:bg-surface-sunken"
                    >
                      <td className="p-3">
                        <div className="font-medium text-text-strong">{zone.name}</div>
                        <div className="text-xs text-text-muted">
                          {zone.areaPostalLabel || 'No area label'}
                        </div>
                        <StatusPill className="mt-2" status={zone.active ? 'Active' : 'Inactive'} />
                      </td>
                      <td className="p-3 tabular-nums">
                        {zone.fixedFee} / {zone.minimumSubtotal}
                      </td>
                      <td className="p-3 tabular-nums">{zone.promisedMinutes} min</td>
                      <td className="p-3">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            onClick={() => setEditor({ kind: 'zone', item: zone })}
                          >
                            Edit
                          </Button>
                          {zone.active ? (
                            <Button
                              variant="destructive"
                              onClick={() =>
                                setConfirmation({ kind: 'deactivate-zone', item: zone })
                              }
                            >
                              Deactivate
                            </Button>
                          ) : (
                            <Button
                              onClick={() =>
                                setConfirmation({ kind: 'reactivate-zone', item: zone })
                              }
                            >
                              Reactivate
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard
          title="Saved addresses"
          titleLevel={2}
          actions={
            <Button disabled={!customerId} onClick={() => setEditor({ kind: 'address' })}>
              <Plus /> Add address
            </Button>
          }
        >
          {!customerId ? <EmptyState text="Select a customer to load saved addresses." /> : null}
          {customerId ? (
            <QueryState
              loading={addresses.isLoading}
              error={addresses.error}
              onRetry={() => void addresses.refetch()}
            />
          ) : null}
          {customerId &&
          !addresses.isLoading &&
          !addresses.error &&
          (addresses.data?.length ?? 0) === 0 ? (
            <EmptyState text="This customer has no saved delivery addresses." />
          ) : null}
          {addresses.data?.length ? (
            <div className="space-y-3">
              {addresses.data.map((address) => (
                <article key={address.id} className="rounded-md border border-border-subtle p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-text-strong">{address.label}</h3>
                        {address.isDefault ? <StatusPill status="Default" tone="info" /> : null}
                      </div>
                      <p className="mt-2 text-sm text-text-body">
                        {address.recipientName} · {address.normalizedPhone}
                      </p>
                      <address className="mt-1 text-sm not-italic text-text-muted">
                        {address.addressLine1}
                        {address.addressLine2 ? `, ${address.addressLine2}` : ''}
                        <br />
                        {[
                          address.locality,
                          address.administrativeArea,
                          address.postalCode,
                          address.countryCode,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </address>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!address.isDefault ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setMutationError('');
                            setDefaultAddress.mutate({ customerId, addressId: address.id });
                          }}
                        >
                          Make default
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        onClick={() => setEditor({ kind: 'address', item: address })}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => setConfirmation({ kind: 'address', item: address })}
                      >
                        Deactivate
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </SectionCard>
      </div>

      <Dialog open={editor != null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          {editor?.kind === 'zone' ? (
            <ZoneForm item={editor.item} busy={busy} error={mutationError} onSubmit={submitZone} />
          ) : null}
          {editor?.kind === 'address' ? (
            <AddressForm
              item={editor.item}
              busy={busy}
              error={mutationError}
              onSubmit={submitAddress}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={confirmation != null} onOpenChange={(open) => !open && setConfirmation(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.kind === 'reactivate-zone'
                ? 'Confirm reactivation'
                : 'Confirm deactivation'}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.kind === 'deactivate-zone'
                ? 'This zone will stop being available for new delivery quotes.'
                : confirmation?.kind === 'reactivate-zone'
                  ? 'This zone will become available for new delivery quotes again.'
                  : 'This saved address will be removed from the customer profile.'}
            </DialogDescription>
          </DialogHeader>
          {mutationError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
            <Button
              variant={confirmation?.kind === 'reactivate-zone' ? 'default' : 'destructive'}
              disabled={busy}
              onClick={() => {
                if (!confirmation) return;
                setMutationError('');
                if (confirmation.kind === 'deactivate-zone')
                  deactivateZone.mutate({ branchId, zoneId: confirmation.item.id });
                else if (confirmation.kind === 'reactivate-zone')
                  reactivateZone.mutate({ branchId, zoneId: confirmation.item.id });
                else deleteAddress.mutate({ customerId, addressId: confirmation.item.id });
              }}
            >
              {busy
                ? confirmation?.kind === 'reactivate-zone'
                  ? 'Reactivating…'
                  : 'Deactivating…'
                : confirmation?.kind === 'reactivate-zone'
                  ? 'Reactivate'
                  : 'Deactivate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-dashed border-border-default px-5 py-10 text-center text-sm text-text-muted">
      {text}
    </p>
  );
}

function ZoneForm({
  item,
  busy,
  error,
  onSubmit,
}: {
  item?: Zone;
  busy: boolean;
  error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>, item?: Zone) => void;
}) {
  return (
    <form onSubmit={(event) => onSubmit(event, item)}>
      <DialogHeader>
        <DialogTitle>{item ? 'Edit delivery zone' : 'Add delivery zone'}</DialogTitle>
        <DialogDescription>
          Fees are entered in the organization currency. All values are validated again by the
          server.
        </DialogDescription>
      </DialogHeader>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Zone name">
          <input
            className={inputClass}
            name="name"
            required
            maxLength={200}
            defaultValue={item?.name}
          />
        </Field>
        <Field label="Area or postal label">
          <input
            className={inputClass}
            name="areaPostalLabel"
            maxLength={500}
            defaultValue={item?.areaPostalLabel ?? ''}
          />
        </Field>
        <Field label="Fixed fee">
          <input
            className={inputClass}
            name="fixedFee"
            required
            inputMode="decimal"
            pattern="\d{1,10}(\.\d{1,2})?"
            defaultValue={item?.fixedFee ?? '0.00'}
          />
        </Field>
        <Field label="Minimum subtotal">
          <input
            className={inputClass}
            name="minimumSubtotal"
            inputMode="decimal"
            pattern="\d{1,10}(\.\d{1,2})?"
            defaultValue={item?.minimumSubtotal ?? '0.00'}
          />
        </Field>
        <Field label="Promised minutes">
          <input
            className={inputClass}
            name="promisedMinutes"
            type="number"
            min={0}
            max={10080}
            required
            defaultValue={item?.promisedMinutes ?? 45}
          />
        </Field>
        <Field label="Sort order">
          <input
            className={inputClass}
            name="sortOrder"
            type="number"
            min={0}
            max={1000000}
            defaultValue={item?.sortOrder ?? 0}
          />
        </Field>
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter className="mt-5">
        <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : item ? 'Save changes' : 'Add zone'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function AddressForm({
  item,
  busy,
  error,
  onSubmit,
}: {
  item?: Address;
  busy: boolean;
  error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>, item?: Address) => void;
}) {
  return (
    <form onSubmit={(event) => onSubmit(event, item)}>
      <DialogHeader>
        <DialogTitle>{item ? 'Edit saved address' : 'Add saved address'}</DialogTitle>
        <DialogDescription>
          This contact and address information is private and visible only to authorized restaurant
          operators.
        </DialogDescription>
      </DialogHeader>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Address label">
          <input
            className={inputClass}
            name="label"
            required
            maxLength={200}
            defaultValue={item?.label}
          />
        </Field>
        <Field label="Recipient name">
          <input
            className={inputClass}
            name="recipientName"
            required
            maxLength={200}
            defaultValue={item?.recipientName}
          />
        </Field>
        <Field label="Phone">
          <input
            className={inputClass}
            name="phone"
            type="tel"
            required
            maxLength={50}
            autoComplete="tel"
            defaultValue={item?.normalizedPhone}
          />
        </Field>
        <Field label="Country code">
          <input
            className={inputClass}
            name="countryCode"
            required
            minLength={2}
            maxLength={2}
            autoCapitalize="characters"
            defaultValue={item?.countryCode ?? ''}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Address line 1">
            <input
              className={inputClass}
              name="addressLine1"
              required
              maxLength={500}
              autoComplete="address-line1"
              defaultValue={item?.addressLine1}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Address line 2">
            <input
              className={inputClass}
              name="addressLine2"
              maxLength={500}
              autoComplete="address-line2"
              defaultValue={item?.addressLine2 ?? ''}
            />
          </Field>
        </div>
        <Field label="City or locality">
          <input
            className={inputClass}
            name="locality"
            required
            maxLength={200}
            autoComplete="address-level2"
            defaultValue={item?.locality}
          />
        </Field>
        <Field label="State or area">
          <input
            className={inputClass}
            name="administrativeArea"
            maxLength={200}
            autoComplete="address-level1"
            defaultValue={item?.administrativeArea ?? ''}
          />
        </Field>
        <Field label="Postal code">
          <input
            className={inputClass}
            name="postalCode"
            maxLength={50}
            autoComplete="postal-code"
            defaultValue={item?.postalCode ?? ''}
          />
        </Field>
        <label className="flex min-h-11 items-center gap-3 text-sm text-text-body">
          <input
            name="isDefault"
            type="checkbox"
            defaultChecked={item?.isDefault}
            disabled={item?.isDefault}
            className="size-4 accent-primary"
          />
          Use as default address
        </label>
        {item?.isDefault ? (
          <p className="text-xs text-text-muted sm:col-span-2">
            To change the default, use Make default on another saved address.
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter className="mt-5">
        <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : item ? 'Save changes' : 'Add address'}
        </Button>
      </DialogFooter>
    </form>
  );
}
