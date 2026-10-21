'use client';
import { useRef, useState } from 'react';
import { browserUuid } from '@/lib/browser-uuid';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';

export function PaymentSandboxPanel({
  branchId,
  saleId,
  deviceId,
  businessDate,
  disabled,
  onRecorded,
}: {
  branchId: string;
  saleId: string;
  deviceId: string;
  businessDate: Date;
  disabled: boolean;
  onRecorded: () => Promise<unknown>;
}) {
  const run = trpc.pharmacySales.sandboxPayment.useMutation();
  const [action, setAction] = useState<'SALE' | 'REFUND'>('SALE');
  const [type, setType] = useState<'CARD' | 'WALLET'>('CARD');
  const [amount, setAmount] = useState('');
  const [tenderId, setTenderId] = useState('');
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<'APPROVED' | 'FAILED' | 'UNKNOWN'>('APPROVED');
  const [mode, setMode] = useState<'EXECUTE' | 'RETRY' | 'RECONCILE'>('EXECUTE');
  const [notice, setNotice] = useState('');
  const operation = useRef<{ key: string; fingerprint: string } | null>(null);
  const [started, setStarted] = useState(false);
  const [resolved, setResolved] = useState(false);
  const control = 'min-h-11 rounded-sm border border-border-default bg-surface-raised px-3';
  return (
    <SectionCard title="Local terminal sandbox">
      <p className="mb-3 text-sm text-text-muted">
        Synthetic token/reference payments only. No card numbers or security codes. No real provider
        certification. Unknown outcomes require explicit reconciliation.
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setNotice('');
          const amountMinor = Number(amount);
          if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
            setNotice('Enter positive integer minor units.');
            return;
          }
          const fingerprint = JSON.stringify([
            branchId,
            saleId,
            deviceId,
            businessDate,
            action,
            type,
            amountMinor,
            tenderId,
          ]);
          if (operation.current && operation.current.fingerprint !== fingerprint) {
            setNotice('Restore the original operation details before retrying or reconciling.');
            return;
          }
          operation.current ??= { key: browserUuid(), fingerprint };
          setStarted(true);
          setResolved(false);
          try {
            const result = await run.mutateAsync({
              branchId,
              saleId,
              deviceId,
              businessDate,
              action,
              type,
              amountMinor,
              ...(action === 'REFUND' ? { originalTenderId: tenderId } : {}),
              operationKey: operation.current.key,
              outcome,
              mode,
              reason,
            });
            setResolved(result.status === 'APPROVED' || result.status === 'FAILED');
            setNotice(
              `${result.status} · ${result.token} · ${result.replayed ? 'replayed' : 'recorded'} (sandbox only)`
            );
            await onRecorded();
          } catch (error) {
            setNotice(
              error instanceof Error
                ? error.message
                : 'Outcome unavailable; do not resend automatically.'
            );
          }
        }}
      >
        <Label className="grid gap-1">
          Action
          <select
            className={control}
            disabled={started}
            value={action}
            onChange={(event) => setAction(event.target.value as typeof action)}
          >
            <option value="SALE">Sale</option>
            <option value="REFUND">Refund returned value</option>
          </select>
        </Label>
        <Label className="grid gap-1">
          Simulated terminal
          <select
            className={control}
            disabled={started}
            value={type}
            onChange={(event) => setType(event.target.value as typeof type)}
          >
            <option value="CARD">Card</option>
            <option value="WALLET">Wallet</option>
          </select>
        </Label>
        <Label className="grid gap-1">
          Amount in minor units
          <Input
            type="number"
            min={1}
            step={1}
            required
            disabled={started}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Label>
        {action === 'REFUND' ? (
          <Label className="grid gap-1">
            Original sandbox tender ID
            <Input
              required
              disabled={started}
              value={tenderId}
              onChange={(event) => setTenderId(event.target.value)}
            />
          </Label>
        ) : null}
        <Label className="grid gap-1">
          Simulated evidence
          <select
            className={control}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as typeof outcome)}
          >
            <option value="APPROVED">Approved</option>
            <option value="FAILED">Definite failure</option>
            <option value="UNKNOWN">Unknown</option>
          </select>
        </Label>
        <Label className="grid gap-1">
          Operation
          <select
            className={control}
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
          >
            <option value="EXECUTE">Execute / read replay</option>
            <option value="RETRY">Retry definite failure</option>
            <option value="RECONCILE">Reconcile unknown</option>
          </select>
        </Label>
        <Label className="grid gap-1">
          Evidence reason
          <Input
            required
            maxLength={160}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Label>
        <Button type="submit" disabled={disabled || run.isPending}>
          {run.isPending ? 'Recording…' : 'Record sandbox operation'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || run.isPending || !resolved}
          onClick={() => {
            operation.current = null;
            setStarted(false);
            setResolved(false);
            setMode('EXECUTE');
            setNotice('New operation ready. Previous operation remains recorded.');
          }}
        >
          New sandbox operation
        </Button>
        <p role="status" className="break-all text-sm sm:col-span-2">
          {notice}
        </p>
      </form>
    </SectionCard>
  );
}
