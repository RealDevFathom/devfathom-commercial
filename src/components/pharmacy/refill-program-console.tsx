'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { inferRouterOutputs } from '@trpc/server';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type Outputs = inferRouterOutputs<AppRouter>['pharmacyOrdering'];
type Subscription = Outputs['refillProgram'][number];
type Cycle = Subscription['cycles'][number];

const SELECT_CLASS =
  'min-h-11 w-full rounded-control border border-border bg-surface-raised px-3 text-sm text-text-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

/** Server refusals in the counter's own words. */
const ERROR_MESSAGES: Record<string, string> = {
  CUSTOMER_NOT_FOUND: 'That customer is no longer active.',
  ITEM_NOT_SUBSCRIBABLE:
    'This item cannot be subscribed. Controlled and restricted medicines need a decision at every sale.',
  INVALID_SCHEDULE: 'Check the schedule: the reminder must come before the cycle ends.',
  KHATA_NOT_AVAILABLE: 'This customer has no khata credit limit. Choose prepay.',
  SUBSCRIPTION_NOT_FOUND: 'This subscription was changed elsewhere. Refresh the list.',
  CYCLE_NOT_FOUND: 'This cycle was changed elsewhere. Refresh the list.',
  CYCLE_ALREADY_OPEN: 'This subscription already has an open cycle.',
  INSUFFICIENT_STOCK: 'There is not enough stock on the shelf to hold this cycle.',
  INVALID_STATE: 'This cycle or subscription has already moved on. Refresh the list.',
  PHARMACIST_APPROVAL_REQUIRED:
    'A pharmacist must sign this prescription cycle against a covering prescription first.',
  PRESCRIPTION_REQUIRED: 'Choose the prescription that covers this cycle.',
  PRESCRIPTION_NOT_FOUND: 'That prescription is not for this medicine and presentation.',
  PRESCRIPTION_PATIENT_MISMATCH: 'That prescription belongs to another patient.',
  PRESCRIPTION_NOT_IN_DATE: 'That prescription is not valid today and on the cycle’s due date.',
  PRESCRIPTION_EXHAUSTED: 'That prescription has no quantity or repeats left for this cycle.',
  DAY_CLOSED: 'Open today’s business day before sending a cycle to the counter.',
};

const SUBSCRIPTION_STATUS: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'danger' }
> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

const CYCLE_STATUS: Record<
  string,
  { label: string; tone: 'warning' | 'info' | 'success' | 'neutral' }
> = {
  AWAITING_PHARMACIST: { label: 'Held for pharmacist', tone: 'warning' },
  RESERVED: { label: 'Stock held', tone: 'info' },
  CHECKOUT_STARTED: { label: 'At the counter', tone: 'success' },
  RELEASED: { label: 'Skipped', tone: 'neutral' },
};

const OPEN_CYCLE = new Set(['AWAITING_PHARMACIST', 'RESERVED']);

function day(value: Date | string) {
  return new Date(value).toLocaleDateString('en-PK', { dateStyle: 'medium' });
}

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return ERROR_MESSAGES[message] ?? message;
}

/**
 * A due date chosen in the form is stored as midday UTC of that calendar date, so
 * the date the reminder carries (its UTC date) and the date staff see in any
 * workspace zone within twelve hours of UTC are the date that was picked.
 */
function dateFromInput(value: string) {
  const [year, month, date] = value.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!, 12));
}

/**
 * DEV-73 refill program: chronic-medicine monthly packs for named customers. Staff
 * create, pause and cancel subscriptions and send ready cycles to the counter. A
 * prescription-only cycle stays held until a pharmacist names the prescription that
 * covers it and signs with their PIN; there is no emergency exception. Due cycles
 * also open on their own every day; the button here only does it sooner.
 */
export function RefillProgramConsole() {
  const utils = trpc.useUtils();
  const branchesQuery = trpc.pharmacyOrdering.branches.useQuery();
  const [branchChoice, setBranchChoice] = useState('');
  const branchId = branchChoice || branchesQuery.data?.branches[0]?.id || '';
  const programQuery = trpc.pharmacyOrdering.refillProgram.useQuery(
    { branchId },
    { enabled: Boolean(branchId), retry: false }
  );
  const setStatus = trpc.pharmacyOrdering.setSubscriptionStatus.useMutation();
  const openCycle = trpc.pharmacyOrdering.openSubscriptionCycle.useMutation();
  const openDue = trpc.pharmacyOrdering.openDueSubscriptionCycles.useMutation();
  const release = trpc.pharmacyOrdering.releaseSubscriptionCycle.useMutation();
  const checkout = trpc.pharmacyOrdering.startSubscriptionCycleCheckout.useMutation();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(
    null
  );
  const [cancelling, setCancelling] = useState<Subscription | null>(null);
  const [approving, setApproving] = useState<{ subscription: Subscription; cycle: Cycle } | null>(
    null
  );
  const [handedOver, setHandedOver] = useState(false);

  const busy =
    setStatus.isPending ||
    openCycle.isPending ||
    openDue.isPending ||
    release.isPending ||
    checkout.isPending;

  async function run(action: () => Promise<unknown>, success: string, counter = false) {
    setNotice(null);
    setHandedOver(false);
    try {
      await action();
      setNotice({ tone: 'success', message: success });
      setHandedOver(counter);
    } catch (error) {
      setNotice({ tone: 'danger', message: errorText(error) });
    } finally {
      await utils.pharmacyOrdering.refillProgram.invalidate();
    }
  }

  if (programQuery.error?.data?.code === 'FORBIDDEN') {
    return (
      <SectionCard title="Refill subscriptions" titleLevel={2}>
        <p className="text-sm text-text-muted" role="status">
          Your role cannot manage refill subscriptions at this branch. Ask the owner for the
          customer orders permission and a branch assignment.
        </p>
      </SectionCard>
    );
  }

  const rows = programQuery.data ?? [];

  return (
    <div className="min-w-0 space-y-6">
      <SectionCard
        title="Refill subscriptions"
        titleLevel={2}
        actions={
          <Button
            variant="outline"
            disabled={!branchId || busy}
            onClick={() =>
              run(async () => {
                const result = await openDue.mutateAsync({ branchId });
                return result;
              }, 'Due cycles opened. Any left out are listed with their reason below.')
            }
          >
            {openDue.isPending ? 'Opening due cycles…' : 'Open due cycles now'}
          </Button>
        }
      >
        <div className="space-y-5">
          <p className="text-sm text-text-muted">
            Due cycles open automatically each day, reserving the stock. Reminders carry only the
            due date, never the medicine.
          </p>
          <div className="max-w-sm space-y-1.5">
            <Label htmlFor="refill-branch">Branch</Label>
            <select
              id="refill-branch"
              className={SELECT_CLASS}
              value={branchId}
              onChange={(event) => setBranchChoice(event.target.value)}
            >
              {(branchesQuery.data?.branches ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </div>

          {notice ? (
            <div
              role={notice.tone === 'danger' ? 'alert' : 'status'}
              className={
                notice.tone === 'danger' ? 'text-sm text-destructive' : 'text-sm text-success'
              }
            >
              {notice.message}{' '}
              {handedOver ? (
                <Link
                  href="/pharmacy/counter"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Go to the counter
                </Link>
              ) : null}
            </div>
          ) : null}
          {openDue.data?.skipped.length ? (
            <ul className="space-y-1 text-sm text-text-muted" aria-label="Cycles not opened">
              {openDue.data.skipped.map((skip) => (
                <li key={skip.subscriptionId}>
                  {rows.find((row) => row.id === skip.subscriptionId)?.customer.displayName ??
                    'A subscription'}
                  : {ERROR_MESSAGES[skip.reason] ?? skip.reason}
                </li>
              ))}
            </ul>
          ) : null}

          {!branchId && branchesQuery.isSuccess ? (
            <p className="text-sm text-text-muted">Add a pharmacy branch first.</p>
          ) : programQuery.isLoading || branchesQuery.isLoading ? (
            <p className="text-sm text-text-muted" role="status">
              Loading refill subscriptions…
            </p>
          ) : programQuery.error ? (
            <p className="text-sm text-destructive" role="alert">
              Refill subscriptions could not be loaded. Nothing was changed. Refresh to try again.
            </p>
          ) : !rows.length ? (
            <p className="text-sm text-text-muted">
              No refill subscriptions at this branch yet. Add the first one below.
            </p>
          ) : (
            <div
              tabIndex={0}
              role="region"
              aria-label="Refill subscriptions"
              className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <table className="w-full min-w-[56rem] text-sm">
                <caption className="sr-only">Refill subscriptions at this branch</caption>
                <thead className="border-b border-border-default text-left font-mono text-xs uppercase">
                  <tr>
                    <th scope="col" className="p-3">
                      Customer
                    </th>
                    <th scope="col" className="p-3">
                      Item
                    </th>
                    <th scope="col" className="p-3 text-right">
                      Packs
                    </th>
                    <th scope="col" className="p-3">
                      Next due
                    </th>
                    <th scope="col" className="p-3">
                      Status
                    </th>
                    <th scope="col" className="p-3">
                      Current cycle
                    </th>
                    <th scope="col" className="p-3 text-right">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const status = SUBSCRIPTION_STATUS[row.status] ?? SUBSCRIPTION_STATUS.ACTIVE!;
                    const cycle = row.cycles[0];
                    const cycleStatus = cycle ? CYCLE_STATUS[cycle.status] : null;
                    const openCycleRow = cycle && OPEN_CYCLE.has(cycle.status) ? cycle : null;
                    const needsPharmacist =
                      openCycleRow &&
                      (openCycleRow.status === 'AWAITING_PHARMACIST' ||
                        (row.item.prescriptionOnly && !openCycleRow.approvedAt));
                    // An approved prescription cycle can take a fresh sign-off that replaces
                    // its prescription, e.g. once another sale used up the one it relied on.
                    const canResign =
                      openCycleRow?.status === 'RESERVED' &&
                      Boolean(openCycleRow.approvedAt) &&
                      (openCycleRow.requiresPharmacist || row.item.prescriptionOnly);
                    return (
                      <tr
                        key={row.id}
                        className="border-b border-border-subtle align-top hover:bg-surface-sunken"
                      >
                        <td className="p-3">
                          <span className="font-semibold text-text-strong">
                            {row.customer.displayName}
                          </span>
                          {row.customer.phoneLast4 ? (
                            <span className="block font-mono text-xs text-text-muted">
                              ···{row.customer.phoneLast4}
                            </span>
                          ) : null}
                        </td>
                        <td className="p-3">
                          <span className="text-text-strong">{row.item.productName}</span>
                          <span className="block text-xs text-text-muted">
                            {[
                              row.item.presentation,
                              row.item.prescriptionOnly ? 'Prescription only' : null,
                              `every ${row.cycleDays} days`,
                              row.paymentMode === 'KHATA' ? 'khata' : 'prepay',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </td>
                        <td className="p-3 text-right tabular-nums">{row.packsPerCycle}</td>
                        <td className="whitespace-nowrap p-3">{day(row.nextDueAt)}</td>
                        <td className="p-3">
                          <StatusPill status={row.status} tone={status.tone} label={status.label} />
                        </td>
                        <td className="p-3">
                          {cycle && cycleStatus ? (
                            <div className="space-y-1">
                              <StatusPill
                                status={cycle.status}
                                tone={cycleStatus.tone}
                                label={cycleStatus.label}
                              />
                              <span className="block text-xs text-text-muted">
                                Due {day(cycle.dueAt)}
                                {cycle.selfApproved ? ' · self-approved with PIN' : ''}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-text-muted">No cycle yet</span>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            {needsPharmacist && openCycleRow ? (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  setApproving({ subscription: row, cycle: openCycleRow })
                                }
                              >
                                Pharmacist sign-off
                              </Button>
                            ) : null}
                            {canResign && openCycleRow ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  setApproving({ subscription: row, cycle: openCycleRow })
                                }
                              >
                                Sign again
                              </Button>
                            ) : null}
                            {openCycleRow && !needsPharmacist ? (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  run(
                                    () =>
                                      checkout.mutateAsync({ branchId, cycleId: openCycleRow.id }),
                                    'Cycle sent to the counter as an open bill.',
                                    true
                                  )
                                }
                              >
                                Send to counter
                              </Button>
                            ) : null}
                            {openCycleRow ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  run(
                                    () =>
                                      release.mutateAsync({ branchId, cycleId: openCycleRow.id }),
                                    'Cycle skipped. Its stock is back on the shelf.'
                                  )
                                }
                              >
                                Skip cycle
                              </Button>
                            ) : null}
                            {row.status === 'ACTIVE' && !openCycleRow ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  run(
                                    () =>
                                      openCycle.mutateAsync({ branchId, subscriptionId: row.id }),
                                    'Cycle opened and its stock reserved.'
                                  )
                                }
                              >
                                Open next cycle
                              </Button>
                            ) : null}
                            {row.status !== 'CANCELLED' ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  run(
                                    () =>
                                      setStatus.mutateAsync({
                                        branchId,
                                        subscriptionId: row.id,
                                        action: row.status === 'PAUSED' ? 'resume' : 'pause',
                                      }),
                                    row.status === 'PAUSED'
                                      ? 'Subscription resumed.'
                                      : 'Subscription paused. No new cycle opens until it resumes.'
                                  )
                                }
                              >
                                {row.status === 'PAUSED' ? 'Resume' : 'Pause'}
                              </Button>
                            ) : null}
                            {row.status !== 'CANCELLED' ? (
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={busy}
                                onClick={() => setCancelling(row)}
                              >
                                Cancel
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SectionCard>

      {branchId ? (
        <NewSubscriptionForm
          branchId={branchId}
          onCreated={async () => {
            setNotice({ tone: 'success', message: 'Refill subscription created.' });
            setHandedOver(false);
            await utils.pharmacyOrdering.refillProgram.invalidate();
          }}
        />
      ) : null}

      {cancelling ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setCancelling(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogTitle>Cancel this refill subscription?</DialogTitle>
            <DialogDescription>
              {cancelling.customer.displayName}: any open cycle is skipped and its stock goes back
              on the shelf. A cancelled subscription cannot be resumed; create a new one instead.
            </DialogDescription>
            <DialogFooter>
              <Button variant="outline" className="h-11" onClick={() => setCancelling(null)}>
                Keep subscription
              </Button>
              <Button
                variant="destructive"
                className="h-11"
                disabled={busy}
                onClick={() => {
                  const target = cancelling;
                  setCancelling(null);
                  void run(
                    () =>
                      setStatus.mutateAsync({
                        branchId,
                        subscriptionId: target.id,
                        action: 'cancel',
                      }),
                    'Subscription cancelled.'
                  );
                }}
              >
                Cancel subscription
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {approving ? (
        <PharmacistSignOffDialog
          branchId={branchId}
          subscription={approving.subscription}
          cycle={approving.cycle}
          onClose={() => setApproving(null)}
          onApproved={async () => {
            setApproving(null);
            setNotice({
              tone: 'success',
              message: 'Cycle signed by the pharmacist. It can now go to the counter.',
            });
            setHandedOver(false);
            await utils.pharmacyOrdering.refillProgram.invalidate();
          }}
        />
      ) : null}
    </div>
  );
}

function NewSubscriptionForm({
  branchId,
  onCreated,
}: {
  branchId: string;
  onCreated: () => Promise<void>;
}) {
  const customersQuery = trpc.pharmacyOrdering.customers.useQuery(undefined, { retry: false });
  const [search, setSearch] = useState('');
  const catalogQuery = trpc.pharmacyOrdering.subscriptionCatalog.useQuery(
    { branchId, search },
    { retry: false }
  );
  const create = trpc.pharmacyOrdering.createSubscription.useMutation();
  const [customerId, setCustomerId] = useState('');
  const [itemKey, setItemKey] = useState('');
  const [packsPerCycle, setPacksPerCycle] = useState('1');
  const [cycleDays, setCycleDays] = useState('30');
  const [reminderLeadDays, setReminderLeadDays] = useState('3');
  const [fulfillment, setFulfillment] = useState<'COLLECT' | 'DELIVER'>('COLLECT');
  const [paymentMode, setPaymentMode] = useState<'PREPAY' | 'KHATA'>('PREPAY');
  const [firstDue, setFirstDue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const items = catalogQuery.data ?? [];
  const item = items.find(
    (row) => `${row.medicineId}:${row.presentationId}:${row.packLevelId}` === itemKey
  );
  const ready = Boolean(customerId && item && firstDue) && !create.isPending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!item || !ready) return;
    setError(null);
    try {
      await create.mutateAsync({
        branchId,
        customerId,
        medicineId: item.medicineId,
        presentationId: item.presentationId,
        packLevelId: item.packLevelId,
        packsPerCycle: Number(packsPerCycle),
        cycleDays: Number(cycleDays),
        reminderLeadDays: Number(reminderLeadDays),
        fulfillment,
        paymentMode,
        firstDueAt: dateFromInput(firstDue),
      });
      setItemKey('');
      setFirstDue('');
      await onCreated();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  return (
    <SectionCard title="New refill subscription" titleLevel={2}>
      <form className="space-y-5" onSubmit={submit} noValidate>
        <p className="text-sm text-text-muted">
          One item for one customer, repeated every cycle. Prescription-only items are held for a
          pharmacist each cycle; controlled and restricted medicines cannot be subscribed.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="refill-customer">Customer</Label>
            <select
              id="refill-customer"
              className={SELECT_CLASS}
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
            >
              <option value="">Choose a customer</option>
              {(customersQuery.data ?? []).map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.displayName}
                  {customer.phoneLast4 ? ` · ${customer.phoneLast4}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refill-item-search">Find item</Label>
            <Input
              id="refill-item-search"
              className="h-11"
              value={search}
              placeholder="Product or brand name"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="refill-item">Item and pack</Label>
            <select
              id="refill-item"
              className={SELECT_CLASS}
              value={itemKey}
              disabled={catalogQuery.isLoading}
              onChange={(event) => setItemKey(event.target.value)}
            >
              <option value="">
                {catalogQuery.isLoading
                  ? 'Loading items…'
                  : items.length
                    ? 'Choose an item'
                    : 'No subscribable item matches'}
              </option>
              {items.map((row) => (
                <option
                  key={`${row.medicineId}:${row.presentationId}:${row.packLevelId}`}
                  value={`${row.medicineId}:${row.presentationId}:${row.packLevelId}`}
                >
                  {row.productName} · {row.presentation} · {row.packLabel}
                  {row.prescriptionOnly ? ' · prescription only' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refill-packs">Packs per cycle</Label>
            <Input
              id="refill-packs"
              className="h-11"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={packsPerCycle}
              onChange={(event) => setPacksPerCycle(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refill-first-due">First due date</Label>
            <Input
              id="refill-first-due"
              className="h-11"
              type="date"
              value={firstDue}
              onChange={(event) => setFirstDue(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refill-cycle-days">Cycle length (days)</Label>
            <Input
              id="refill-cycle-days"
              className="h-11"
              type="number"
              inputMode="numeric"
              min={1}
              max={180}
              value={cycleDays}
              onChange={(event) => setCycleDays(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refill-lead-days">Open and remind (days before due)</Label>
            <Input
              id="refill-lead-days"
              className="h-11"
              type="number"
              inputMode="numeric"
              min={0}
              max={30}
              value={reminderLeadDays}
              onChange={(event) => setReminderLeadDays(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refill-fulfillment">Hand-over</Label>
            <select
              id="refill-fulfillment"
              className={SELECT_CLASS}
              value={fulfillment}
              onChange={(event) => setFulfillment(event.target.value as 'COLLECT' | 'DELIVER')}
            >
              <option value="COLLECT">Customer collects</option>
              <option value="DELIVER">Staff delivers</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refill-payment">Payment</Label>
            <select
              id="refill-payment"
              className={SELECT_CLASS}
              value={paymentMode}
              onChange={(event) => setPaymentMode(event.target.value as 'PREPAY' | 'KHATA')}
            >
              <option value="PREPAY">Prepay at the counter</option>
              <option value="KHATA">Khata</option>
            </select>
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="touch" disabled={!ready}>
          {create.isPending ? 'Creating subscription…' : 'Create subscription'}
        </Button>
      </form>
    </SectionCard>
  );
}

function PharmacistSignOffDialog({
  branchId,
  subscription,
  cycle,
  onClose,
  onApproved,
}: {
  branchId: string;
  subscription: Subscription;
  cycle: Cycle;
  onClose: () => void;
  onApproved: () => Promise<void>;
}) {
  const prescriptionsQuery = trpc.pharmacyOrdering.subscriptionCyclePrescriptions.useQuery(
    { branchId, cycleId: cycle.id },
    { retry: false }
  );
  const approversQuery = trpc.pharmacyOrdering.subscriptionCycleApprovers.useQuery(
    { branchId },
    { retry: false }
  );
  const approve = trpc.pharmacyOrdering.approveSubscriptionCycle.useMutation();
  const [prescriptionLineId, setPrescriptionLineId] = useState('');
  const [staffProfileId, setStaffProfileId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const forbidden = prescriptionsQuery.error?.data?.code === 'FORBIDDEN';
  const lines = prescriptionsQuery.data ?? [];
  const approvers = approversQuery.data ?? [];
  const ready =
    Boolean(prescriptionLineId && staffProfileId) && /^\d{4,8}$/.test(pin) && !approve.isPending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    const entered = pin;
    setPin('');
    try {
      await approve.mutateAsync({
        branchId,
        cycleId: cycle.id,
        prescriptionLineId,
        pharmacistPin: { staffProfileId, pin: entered },
      });
      await onApproved();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogTitle>Pharmacist sign-off for this cycle</DialogTitle>
          <DialogDescription>
            {subscription.customer.displayName}, due {day(cycle.dueAt)}. The cycle stays held until
            a valid prescription covers it and a pharmacist signs with their PIN. There is no
            emergency exception. A sole owner-pharmacist can sign with their own PIN; it is recorded
            as self-approved.
          </DialogDescription>

          {forbidden ? (
            <p role="alert" className="text-sm text-destructive">
              Only a pharmacist can read and sign prescriptions for refill cycles.
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text-strong">
                Covering prescription
              </legend>
              {prescriptionsQuery.isLoading ? (
                <p role="status" className="text-sm text-text-muted">
                  Loading prescriptions…
                </p>
              ) : prescriptionsQuery.error ? (
                <p role="alert" className="text-sm text-destructive">
                  Prescriptions could not be loaded. Close and try again.
                </p>
              ) : !lines.length ? (
                <p className="text-sm text-text-muted">
                  No prescription on this customer’s patient record matches this item. Record the
                  prescription in Prescriptions first; the cycle stays held.
                </p>
              ) : (
                lines.map((line) => (
                  <label
                    key={line.id}
                    className="flex cursor-pointer items-start gap-3 rounded-md border border-border-subtle p-3 has-[:checked]:border-ring"
                  >
                    <input
                      type="radio"
                      name="refill-prescription"
                      className="mt-1"
                      value={line.id}
                      checked={prescriptionLineId === line.id}
                      onChange={() => setPrescriptionLineId(line.id)}
                    />
                    <span className="text-sm">
                      <span className="block text-text-strong">{line.prescriberName}</span>
                      <span className="block text-text-muted">
                        Valid {day(line.validFrom)} to {day(line.validUntil)} ·{' '}
                        {line.remainingUnits} units and {line.repeatsLeft} fills left
                      </span>
                    </span>
                  </label>
                ))
              )}
            </fieldset>
          )}

          <div className="grid gap-2">
            <Label htmlFor="refill-pharmacist">Signing pharmacist</Label>
            <select
              id="refill-pharmacist"
              className={SELECT_CLASS}
              value={staffProfileId}
              disabled={forbidden || approversQuery.isLoading}
              onChange={(event) => {
                setStaffProfileId(event.target.value);
                setPin('');
              }}
            >
              <option value="">
                {approversQuery.isLoading ? 'Loading pharmacists…' : 'Choose pharmacist'}
              </option>
              {approvers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.self ? `${row.name} (you)` : row.name}
                </option>
              ))}
            </select>
            {approversQuery.isSuccess && !approvers.length ? (
              <p role="status" className="text-sm text-text-muted">
                No pharmacist has an active staff PIN. Ask your administrator to set one up.
              </p>
            ) : null}
            <Label htmlFor="refill-pharmacist-pin">Pharmacist PIN</Label>
            <Input
              id="refill-pharmacist-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              className="h-11"
              value={pin}
              disabled={forbidden || !staffProfileId}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" className="h-11" onClick={onClose}>
              Close
            </Button>
            <Button type="submit" className="h-11" disabled={!ready || forbidden}>
              {approve.isPending ? 'Signing…' : 'Sign and release cycle'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The link from the customer orders page. */
export function RefillProgramLink() {
  return (
    <Link href="/pharmacy/orders/refills" className={buttonVariants({ variant: 'outline' })}>
      Refill program
    </Link>
  );
}
