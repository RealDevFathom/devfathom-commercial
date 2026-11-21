'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';
import { formatUtcInstant } from '@/lib/utc-instant';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { amountInputError, amountInputToMinor } from '@/lib/money-input';
import {
  savePrepaid,
  recordPrepaid,
  setCustomerPrepaidPin,
  type PrepaidFormState,
} from './actions';
const initial: PrepaidFormState = { status: 'idle', message: '' };
const selectClass =
  'min-h-11 w-full rounded-sm border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring';
export function TierSettingsForm({
  tiers,
  refundable,
}: {
  tiers: { name: string; upfrontMinor: number; discountBasisPoints: number }[];
  refundable: boolean;
}) {
  const [rows, setRows] = useState(
    tiers.map((t) => ({
      name: t.name,
      amount: String(t.upfrontMinor / 100),
      percent: String(t.discountBasisPoints / 100),
    }))
  );
  const [state, action, pending] = useActionState(savePrepaid, initial);
  // DEV-942: the upfront amount is read by the shared exact reader; a refused entry is
  // explained and the settings are not sent. After a refused save the message follows the
  // fields, so it clears as soon as the amount is corrected.
  const [checkAmounts, setCheckAmounts] = useState(false);
  const update = (index: number, key: 'name' | 'amount' | 'percent', value: string) =>
    setRows((old) => old.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  const amounts = rows.map((row) => amountInputToMinor(row.amount));
  const refusedIndex = amounts.findIndex((amount) => amount.status !== 'OK');
  const refused = amounts[refusedIndex];
  const amountProblem =
    !refused || refused.status === 'OK'
      ? ''
      : `Tier ${refusedIndex + 1} upfront amount: ${
          refused.status === 'EMPTY'
            ? 'Enter an amount, for example 5000.'
            : amountInputError(refused.reason)
        }`;
  const amountError = checkAmounts ? amountProblem : '';
  const refuseAmount = (event: { preventDefault(): void }) => {
    setCheckAmounts(amountProblem !== '');
    if (amountProblem) event.preventDefault();
  };
  return (
    <form action={action} onSubmit={refuseAmount} className="space-y-4">
      <input
        type="hidden"
        name="tiers"
        value={JSON.stringify(
          rows.map((row, i) => {
            const amount = amounts[i];
            return {
              name: row.name,
              upfrontMinor: amount.status === 'OK' ? amount.minor : null,
              discountBasisPoints: Math.round(Number(row.percent) * 100),
            };
          })
        )}
      />
      {!rows.length && (
        <p className="text-sm text-text-muted">
          No tiers configured. Add the first tier to offer a prepaid discount.
        </p>
      )}
      {rows.map((row, i) => (
        <fieldset
          key={i}
          disabled={pending}
          className="grid min-w-0 gap-3 rounded-md border border-border-subtle p-4 sm:grid-cols-3"
        >
          <legend className="px-2 text-sm">Tier {i + 1}</legend>
          <label className="grid gap-2 text-sm">
            Tier name
            <Input
              className="min-h-11"
              required
              maxLength={60}
              value={row.name}
              onChange={(e) => update(i, 'name', e.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm">
            Upfront amount (PKR)
            <Input
              className="min-h-11"
              required
              type="number"
              min="0.01"
              step="0.01"
              max="20000000"
              value={row.amount}
              onChange={(e) => update(i, 'amount', e.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm">
            Discount (%)
            <Input
              className="min-h-11"
              required
              type="number"
              min="0.01"
              max="99.99"
              step="0.01"
              value={row.percent}
              onChange={(e) => update(i, 'percent', e.target.value)}
            />
          </label>
          <Button
            className="min-h-11"
            type="button"
            variant="secondary"
            onClick={() => setRows((old) => old.filter((_, n) => n !== i))}
          >
            Remove tier {i + 1}
          </Button>
        </fieldset>
      ))}
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" name="refundable" defaultChecked={refundable} disabled={pending} />
        Future upfront payments are refundable
      </label>
      <p className="text-sm text-text-muted">
        Each payment receipt states its refund terms. Non-refundable funds are spent first. A zero
        balance ends the tier; qualifying payments start again from zero. Existing customers retain
        their awarded tier until their next upfront payment or their balance reaches zero.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          className="min-h-11"
          type="button"
          variant="secondary"
          disabled={pending || rows.length >= 20}
          onClick={() => setRows((old) => [...old, { name: '', amount: '', percent: '' }])}
        >
          Add tier
        </Button>
        <Button className="min-h-11" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save dated settings'}
        </Button>
      </div>
      {amountError ? (
        <p role="alert">{amountError}</p>
      ) : (
        state.message && <p role={state.status === 'error' ? 'alert' : 'status'}>{state.message}</p>
      )}
    </form>
  );
}
export function PrepaidPaymentForm({
  customers,
  branches,
  drawers,
  customerId,
  paymentReference,
}: {
  paymentReference: string;
  drawers: { branchId: string; deviceId: string; label: string }[];
  customers: { id: string; displayName: string; pinSet: boolean }[];
  branches: { id: string; name: string }[];
  customerId?: string;
}) {
  const [state, action, pending] = useActionState(recordPrepaid, initial);
  const [key] = useState(paymentReference);
  const [kind, setKind] = useState('PAYMENT');
  const [selectedCustomer, setSelectedCustomer] = useState(customerId ?? customers[0]?.id ?? '');
  const pinRequired = !customers.find((c) => c.id === selectedCustomer)?.pinSet;
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const availableDrawers = drawers.filter((d) => d.branchId === branchId);
  const receipt = state.receipt;
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4 print:hidden">
        <input type="hidden" name="idempotencyKey" value={key} />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm">
            Customer
            <StudioSelect
              name="customerId"
              className={selectClass}
              value={selectedCustomer}
              onChange={(e) => setSelectedCustomer(e.target.value)}
              required
              disabled={pending}
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </StudioSelect>
          </label>
          <label className="grid gap-2 text-sm">
            Branch
            <StudioSelect
              name="branchId"
              className={selectClass}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              required
              disabled={pending}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </StudioSelect>
          </label>
          <label className="grid gap-2 text-sm">
            Open cash drawer
            <StudioSelect
              name="deviceId"
              className={selectClass}
              required
              disabled={pending || !availableDrawers.length}
            >
              {availableDrawers.length ? (
                availableDrawers.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))
              ) : (
                <option value="">Open a drawer at the counter first</option>
              )}
            </StudioSelect>
          </label>
          <label className="grid gap-2 text-sm">
            Amount (PKR)
            <Input
              className="min-h-11"
              name="amount"
              required
              type="number"
              min="0.01"
              max="20000000"
              step="0.01"
              disabled={pending}
            />
          </label>
          <label className="grid gap-2 text-sm">
            Movement
            <StudioSelect
              name="kind"
              className={selectClass}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              disabled={pending}
            >
              <option value="PAYMENT">Upfront cash payment</option>
              <option value="REFUND">Refund prepaid cash</option>
            </StudioSelect>
          </label>
          {kind === 'PAYMENT' && (
            <label className="grid gap-2 text-sm">
              {pinRequired
                ? 'Customer’s new prepaid PIN (customer types it)'
                : 'New prepaid PIN (optional, customer types it)'}
              <Input
                className="min-h-11"
                name="customerPin"
                type="password"
                inputMode="numeric"
                pattern="[0-9]{4,8}"
                required={pinRequired}
                autoComplete="off"
                disabled={pending}
              />
            </label>
          )}
          {kind === 'REFUND' && (
            <label className="grid gap-2 text-sm">
              Your owner PIN
              <Input
                className="min-h-11"
                name="pin"
                type="password"
                inputMode="numeric"
                pattern="[0-9]{4,8}"
                required
                autoComplete="off"
                disabled={pending}
              />
            </label>
          )}
        </div>
        {kind === 'REFUND' && (
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" required disabled={pending} />I confirm this prepaid cash refund
          </label>
        )}
        <p className="text-sm text-text-muted">
          Confirm cash received before recording an upfront payment. The customer enters their own
          prepaid PIN at the counter to spend this balance. Refunds use the signed-in owner’s fresh
          PIN, including for a solo owner.
        </p>
        <Button
          className="min-h-11"
          type="submit"
          disabled={
            pending ||
            !!receipt ||
            !customers.length ||
            !branches.length ||
            !availableDrawers.length
          }
        >
          {pending
            ? 'Recording…'
            : kind === 'REFUND'
              ? 'Record cash refund'
              : 'Record cash received'}
        </Button>
        {receipt && (
          <Button
            className="min-h-11"
            type="button"
            variant="secondary"
            onClick={() => window.location.reload()}
          >
            Start another payment
          </Button>
        )}
        {state.message && (
          <p role={state.status === 'error' ? 'alert' : 'status'}>{state.message}</p>
        )}
      </form>
      {receipt && (
        <SectionCard className="prepaid-receipt" title="Prepaid receipt" titleLevel={3}>
          <style>{`@media print { body * { visibility: hidden; } .prepaid-receipt, .prepaid-receipt * { visibility: visible; } .prepaid-receipt { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>
          <div className="space-y-2 break-words text-sm">
            <p>Reference: {receipt.id}</p>
            <p>{formatUtcInstant(new Date(receipt.createdAt))}</p>
            <p>
              {receipt.amountMinor > 0 ? 'Upfront payment' : 'Refund'}: PKR{' '}
              {formatMinor(Math.abs(receipt.amountMinor))}
            </p>
            <p>Prepaid balance: PKR {formatMinor(receipt.balanceMinor)}</p>
            <p>Tier: {receipt.tier ?? 'None'}</p>
            {receipt.refundable !== null && (
              <p className="font-semibold">
                {receipt.refundable
                  ? 'Refundable prepaid balance'
                  : 'Non-refundable prepaid balance'}
              </p>
            )}
            <p>Prepaid funds are held for future purchases and spent through the wallet tender.</p>
            <Button
              className="min-h-11"
              type="button"
              variant="secondary"
              onClick={() => window.print()}
            >
              Print prepaid receipt
            </Button>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

export function PrepaidPinForm({
  customers,
  customerId,
}: {
  customers: { id: string; displayName: string }[];
  customerId?: string;
}) {
  const [state, action, pending] = useActionState(setCustomerPrepaidPin, initial);
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm">
          Customer
          <StudioSelect
            name="customerId"
            className={selectClass}
            defaultValue={customerId}
            required
            disabled={pending}
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </StudioSelect>
        </label>
        <label className="grid gap-2 text-sm">
          New prepaid PIN (customer types it)
          <Input
            className="min-h-11"
            name="customerPin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]{4,8}"
            required
            autoComplete="off"
            disabled={pending}
          />
        </label>
      </div>
      <p className="text-sm text-text-muted">
        Use this when a customer forgets their PIN. Only the customer should type the new PIN.
      </p>
      <Button className="min-h-11" type="submit" disabled={pending || !customers.length}>
        {pending ? 'Saving…' : 'Set prepaid PIN'}
      </Button>
      {state.message && <p role={state.status === 'error' ? 'alert' : 'status'}>{state.message}</p>}
    </form>
  );
}
