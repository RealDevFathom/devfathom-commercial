'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import type { z } from 'zod';
import type { deliveryCommandInput } from '@/lib/pharmacy/customer-delivery';
type Action = z.infer<typeof deliveryCommandInput>['action'];

export function DeliveryEvidenceForm({ branchId, orderId }: { branchId: string; orderId: string }) {
  const command = trpc.pharmacyOrdering.deliveryCommand.useMutation();
  // DEV-786: only managers and owners may refund or return. deliveryCommand enforces the same rule.
  const access = trpc.pharmacySales.refundAccess.useQuery(undefined, { retry: false });
  const refundAuthorized = access.data?.authorized === true;
  const utils = trpc.useUtils();
  const [action, setAction] = useState<Action>('COLLECT');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [location, setLocation] = useState('');
  const [managerPin, setManagerPin] = useState('');
  const [requestKey, setRequestKey] = useState('');
  const [notice, setNotice] = useState('');
  const moneyAction = ['COLLECT', 'REMIT', 'CASH_RETURN'].includes(action);
  return (
    <details className="mt-4 border-t border-border-subtle pt-3">
      <summary className="cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">
        Delivery custody and reconciliation
      </summary>
      <p className="my-3 text-sm text-text-muted">
        Quoted COD is not collected cash or revenue. Remittance needs a separate receiver and an
        open counter drawer. Physical returns remain quarantined for inspection; payment
        discrepancies are never silently cleared.
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setNotice('');
          // DEV-647: the PIN is single-use and never kept in the form after submitting.
          const pin = action === 'PHYSICAL_RETURN' && refundAuthorized ? managerPin : '';
          setManagerPin('');
          try {
            const result = await command.mutateAsync({
              branchId,
              orderId,
              action,
              reference,
              requestKey,
              ...(moneyAction ? { amountMinor: Number(amount) } : {}),
              ...(action === 'REMIT' || action === 'PHYSICAL_RETURN'
                ? { deviceId, businessDate: new Date(new Date().toISOString().slice(0, 10)) }
                : {}),
              ...(action === 'PHYSICAL_RETURN' && location
                ? { quarantineLocationId: location }
                : {}),
              ...(pin ? { managerPin: pin } : {}),
            });
            setNotice(
              `${result.replayed ? 'Already recorded' : 'Recorded'}; collected ${result.totals.collectedMinor}, remitted ${result.totals.remittedMinor}, cash still with runner ${result.totals.custodyMinor} minor units.`
            );
            await Promise.all([
              utils.pharmacyOrdering.mine.invalidate(),
              utils.pharmacyOrdering.staffQueue.invalidate(),
            ]);
          } catch (error) {
            setNotice(
              error instanceof Error
                ? error.message
                : 'Unknown outcome. Reuse the same operation key.'
            );
          }
        }}
      >
        <Label className="grid gap-1">
          Evidence action
          <select
            className="min-h-11 rounded-sm border border-border-default bg-surface-raised px-3"
            value={action}
            onChange={(event) => setAction(event.target.value as Action)}
          >
            <option value="COLLECT">Runner collected COD</option>
            <option value="REMIT">Cashier received remittance</option>
            <option value="VARIANCE">Record current cash variance</option>
            <option value="REFUSED">Customer refused</option>
            <option value="FAILED">Delivery failed</option>
            <option value="CASH_RETURN">Runner returned cash to customer</option>
            <option value="PHYSICAL_RETURN">Branch received physical goods</option>
          </select>
        </Label>
        {moneyAction ? (
          <Label className="grid gap-1">
            Actual amount in minor units
            <Input
              required
              type="number"
              min={1}
              step={1}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Label>
        ) : null}
        <Label className="grid gap-1">
          Evidence reference
          <Input
            required
            maxLength={160}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </Label>
        <Label className="grid gap-1">
          Operation key (reuse for retry)
          <Input
            required
            maxLength={128}
            value={requestKey}
            onChange={(event) => setRequestKey(event.target.value)}
          />
        </Label>
        {action === 'REMIT' || action === 'PHYSICAL_RETURN' ? (
          <Label className="grid gap-1">
            Open drawer device ID (required for cash refunds)
            <Input
              required
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
            />
          </Label>
        ) : null}
        {action === 'PHYSICAL_RETURN' ? (
          <Label className="grid gap-1">
            Quarantine location ID (sold goods)
            <Input value={location} onChange={(event) => setLocation(event.target.value)} />
          </Label>
        ) : null}
        {action === 'PHYSICAL_RETURN' && !refundAuthorized ? (
          <p role="note" className="text-sm text-text-muted sm:col-span-2">
            Refunding paid cash or returning a completed sale needs a manager or owner. Ask one to
            record this return with their PIN.
          </p>
        ) : null}
        {action === 'PHYSICAL_RETURN' && refundAuthorized ? (
          <Label className="grid gap-1">
            Manager or owner PIN (required to refund cash or return a completed sale)
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={managerPin}
              onChange={(event) => setManagerPin(event.target.value.replace(/\D/g, ''))}
            />
          </Label>
        ) : null}
        <Button type="submit" disabled={command.isPending}>
          {command.isPending ? 'Recording…' : 'Record custody evidence'}
        </Button>
        <p role="status" className="text-sm sm:col-span-2">
          {notice}
        </p>
      </form>
    </details>
  );
}
