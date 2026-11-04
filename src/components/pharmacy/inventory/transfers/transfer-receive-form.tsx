import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { TransferActionForm, type TransferStepAction } from './transfer-action-form';
import { transferReference, type TransferBoardRow } from './transfer-presentation';

export type Witness = { id: string; name: string | null; title: string | null };

export const selectClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Receive all or part of the remaining delivery. Without variance evidence,
 * unreceived units stay in transit. Explicit evidence closes a real shortfall.
 */
export function TransferReceiveForm({
  transfer,
  branchId,
  witnesses,
  action,
}: {
  transfer: TransferBoardRow;
  branchId: string;
  witnesses: ReadonlyArray<Witness>;
  action: TransferStepAction;
}) {
  const reference = transferReference(transfer.id);
  const open = transfer.lines.filter((line) => line.receivedUnits < line.quantityUnits);

  return (
    <TransferActionForm
      action={action}
      className="mt-4 grid gap-3 border-t border-border-subtle pt-4 md:grid-cols-3"
      label={`Receive ${reference}`}
    >
      <input name="action" type="hidden" value="receive" />
      <input name="branchId" type="hidden" value={branchId} />
      <input name="transferId" type="hidden" value={transfer.id} />
      <input name="receiptKey" type="hidden" value={crypto.randomUUID()} />
      {open.map((line) => (
        <label className="text-sm" key={line.id}>
          Received units — {line.medicineName} · batch {line.batchNumber}
          <Input
            className="mt-1"
            defaultValue={line.quantityUnits - line.receivedUnits}
            inputMode="numeric"
            max={line.quantityUnits - line.receivedUnits}
            min={0}
            name={`received:${line.id}`}
            required
            type="number"
          />
          <span className="mt-1 block text-xs text-text-muted">
            {line.quantityUnits - line.receivedUnits} outstanding
          </span>
        </label>
      ))}
      <fieldset className="grid gap-3 rounded-[var(--radius-sm)] bg-surface-sunken p-3 md:col-span-3 md:grid-cols-3">
        <legend className="px-1 text-xs text-text-muted">
          Close a permanent shortfall — leave blank for a partial delivery
        </legend>
        <label className="text-sm md:col-span-3">
          Variance reason
          <Input className="mt-1" maxLength={500} name="varianceReason" />
        </label>
        <label className="text-sm">
          Witness
          <select className={selectClass} defaultValue="" name="witnessId">
            <option value="">Still in transit</option>
            {witnesses.map((witness) => (
              <option key={witness.id} value={witness.id}>
                {witness.name ?? 'Unnamed colleague'}
                {witness.title ? ` · ${witness.title}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm md:col-span-2">
          Evidence reference
          <Input
            className="mt-1"
            maxLength={200}
            name="evidenceRef"
            placeholder="Driver note, seal number or photo reference"
          />
        </label>
      </fieldset>
      <Button className="md:col-span-3" type="submit">
        Receive {reference}
      </Button>
    </TransferActionForm>
  );
}
