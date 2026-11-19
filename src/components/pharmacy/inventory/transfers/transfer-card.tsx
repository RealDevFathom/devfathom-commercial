import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatLotExpiry } from '@/lib/pharmacy/product-class';

import { PackingSlipPrintButton } from './packing-slip-print-button';
import { TransferActionForm, type TransferStepAction } from './transfer-action-form';
import { TransferReceiveForm, type Witness } from './transfer-receive-form';
import {
  packingSlipFor,
  RECEIVABLE_STATUSES,
  SLIP_STATUSES,
  transferReference,
  transferStatusLabel,
  transferStatusTone,
  type TransferBoardRow,
} from './transfer-presentation';
import { batchPhrase } from '@/lib/pharmacy/unrecorded-batch';

const when = (value: Date | string) =>
  new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium' }).format(new Date(value));

/** One transfer: what moves, where it stands, and the next step this branch owns. */
export function TransferCard({
  transfer,
  branchId,
  currentUserId,
  witnesses,
  action,
  soloApprover = false,
}: {
  transfer: TransferBoardRow;
  branchId: string;
  currentUserId: string;
  witnesses: ReadonlyArray<Witness>;
  action: TransferStepAction;
  /** The signed-in owner works alone, so they approve their own allocation with a PIN. */
  soloApprover?: boolean;
}) {
  const reference = transferReference(transfer.id);
  const outbound = transfer.direction === 'OUTBOUND';
  const ownAllocation = transfer.allocatedById === currentUserId;
  const totalUnits = transfer.lines.reduce((sum, line) => sum + line.quantityUnits, 0);

  return (
    <article
      aria-labelledby={`transfer-${transfer.id}`}
      className="rounded-[var(--radius-md)] border border-border-subtle p-4"
      data-testid="transfer-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase text-text-muted">
            {reference} · {outbound ? 'Outbound' : 'Inbound'} · {totalUnits} units
          </p>
          <h3 className="mt-1 font-semibold text-text-strong" id={`transfer-${transfer.id}`}>
            {transfer.fromBranch.name ?? 'Source branch'} →{' '}
            {transfer.toBranch.name ?? 'Destination branch'}
          </h3>
          <p className="mt-1 text-xs text-text-muted">
            {transfer.status === 'DRAFT' ? 'Requested' : 'Allocated'} {when(transfer.createdAt)}
            {transfer.allocatedByName ? ` by ${transfer.allocatedByName}` : ''}
            {transfer.approvedByName ? ` · approved by ${transfer.approvedByName}` : ''}
            {transfer.dispatchedAt ? ` · dispatched ${when(transfer.dispatchedAt)}` : ''}
            {transfer.receivedAt ? ` · closed ${when(transfer.receivedAt)}` : ''}
            {transfer.receivedByName ? ` by ${transfer.receivedByName}` : ''}
          </p>
          {transfer.fromLicenceNumber && transfer.toLicenceNumber ? (
            <p className="mt-1 font-mono text-xs text-text-muted">
              Licence {transfer.fromLicenceNumber} → {transfer.toLicenceNumber}
            </p>
          ) : null}
        </div>
        <StatusPill
          label={transferStatusLabel(transfer)}
          status={transfer.status}
          tone={transferStatusTone(transfer)}
        />
      </div>

      <div className="mt-4 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Medicine / batch</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Pick → put</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Variance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transfer.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell>
                  <span className="font-medium text-text-strong">{line.medicineName}</span>
                  <span className="block text-xs text-text-muted">
                    {batchPhrase(line.batchNumber)}
                  </span>
                </TableCell>
                <TableCell>{formatLotExpiry(line.expiresAt, when)}</TableCell>
                <TableCell className="text-sm">
                  {line.sourceLocation?.name ?? 'Unknown'} →{' '}
                  {line.destinationLocation?.name ?? 'Unknown'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {line.quantityUnits}
                  <span className="block text-xs text-text-muted">
                    {line.sealedPacks} sealed + {line.looseUnits} loose
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{line.receivedUnits}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {line.varianceUnits > 0 ? (
                    <span className="text-warning" title={line.varianceReason ?? undefined}>
                      −{line.varianceUnits} written off
                    </span>
                  ) : (
                    '—'
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {SLIP_STATUSES.has(transfer.status) ? (
          <PackingSlipPrintButton slip={packingSlipFor(transfer)} />
        ) : null}
        {outbound && transfer.status === 'DRAFT' ? (
          <TransferActionForm action={action}>
            <input name="action" type="hidden" value="allocate-request" />
            <input name="branchId" type="hidden" value={branchId} />
            <input name="transferId" type="hidden" value={transfer.id} />
            <Button size="sm" type="submit" variant="secondary">
              Allocate request {reference}
            </Button>
          </TransferActionForm>
        ) : null}
        {!outbound && transfer.status === 'DRAFT' ? (
          <p className="text-xs text-text-muted">
            Requested — {transfer.fromBranch.name ?? 'the source branch'} allocates it, then a
            colleague approves it. Nothing has moved yet.
          </p>
        ) : null}
        {outbound && transfer.status === 'ALLOCATED' ? (
          ownAllocation ? (
            soloApprover ? (
              <TransferActionForm action={action} className="flex flex-wrap items-end gap-2">
                <input name="action" type="hidden" value="approve" />
                <input name="branchId" type="hidden" value={branchId} />
                <input name="transferId" type="hidden" value={transfer.id} />
                <label className="text-sm">
                  Your PIN
                  <Input
                    autoComplete="off"
                    className="mt-1 w-32"
                    inputMode="numeric"
                    maxLength={8}
                    name="soloPin"
                    pattern="[0-9]{4,8}"
                    required
                    type="password"
                  />
                </label>
                <Button size="sm" type="submit">
                  Approve {reference} with PIN
                </Button>
              </TransferActionForm>
            ) : (
              <p className="text-xs text-text-muted">
                Waiting for a colleague to approve — you allocated this transfer.
              </p>
            )
          ) : (
            <TransferActionForm action={action}>
              <input name="action" type="hidden" value="approve" />
              <input name="branchId" type="hidden" value={branchId} />
              <input name="transferId" type="hidden" value={transfer.id} />
              <Button size="sm" type="submit">
                Approve {reference}
              </Button>
            </TransferActionForm>
          )
        ) : null}
        {outbound && transfer.status === 'APPROVED' ? (
          <TransferActionForm action={action}>
            <input name="action" type="hidden" value="dispatch" />
            <input name="branchId" type="hidden" value={branchId} />
            <input name="transferId" type="hidden" value={transfer.id} />
            <Button size="sm" type="submit">
              Dispatch {reference}
            </Button>
          </TransferActionForm>
        ) : null}
        {outbound && RECEIVABLE_STATUSES.has(transfer.status) ? (
          <p className="text-xs text-text-muted">
            In transit — {transfer.toBranch.name ?? 'the destination'} receives it.
          </p>
        ) : null}
      </div>

      {!outbound && RECEIVABLE_STATUSES.has(transfer.status) ? (
        <TransferReceiveForm
          action={action}
          branchId={branchId}
          transfer={transfer}
          witnesses={witnesses}
        />
      ) : null}
    </article>
  );
}
