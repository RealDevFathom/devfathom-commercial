'use client';

import { trpc } from '@/lib/trpc';
import { SectionCard } from '@/components/ui/section-card';
import { PackingSlipPrintButton } from '@/components/pharmacy/inventory/transfers/packing-slip-print-button';
import {
  isDispatchHeld,
  packingSlipFor,
  SLIP_STATUSES,
  transferReference,
} from '@/components/pharmacy/inventory/transfers/transfer-presentation';
import { ActionForm, Field, Problem, Quiet, read } from './form';

export function Outbound({ branchId }: { branchId: string }) {
  const orders = trpc.pharmacyWarehouse.outbound.useQuery({ branchId });
  const board = trpc.pharmacyWarehouse.overview.useQuery({ branchId });
  const transfers = trpc.pharmacyInventory.transferBoard.useQuery({ branchId });
  const adopt = trpc.pharmacyWarehouse.adoptTransfer.useMutation();
  const replenish = trpc.pharmacyWarehouse.replenish.useMutation();
  const cancel = trpc.pharmacyWarehouse.cancel.useMutation();
  const pick = trpc.pharmacyWarehouse.pick.useMutation();
  const pack = trpc.pharmacyWarehouse.pack.useMutation();
  const approve = trpc.pharmacyInventory.approveTransfer.useMutation();
  const dispatch = trpc.pharmacyInventory.dispatchTransfer.useMutation();
  const evidence = trpc.pharmacyWarehouse.dispatchEvidence.useMutation();
  return (
    <div className="space-y-4">
      <SectionCard title="Outbound work">
        {orders.error ? (
          <Problem error={orders.error} retry={() => void orders.refetch()} />
        ) : !orders.data ? (
          <p role="status">Loading orders…</p>
        ) : !orders.data.length ? (
          <Quiet>No warehouse orders yet. Approve a branch request to reserve stock.</Quiet>
        ) : (
          orders.data.map((order) => {
            const transfer = transfers.data?.find((t) => t.id === order.transferId);
            const orderId = order.id;
            const transferId = order.transferId;
            const live = order.reservations.filter(
              (r) => r.state !== 'CANCELLED' && r.transferId === transferId
            );
            const ready = live.length > 0 && live.every((r) => r.state === 'PACKED');
            const short = order.demands.reduce((sum, d) => sum + d.shortfallUnits, 0);
            return (
              <article key={orderId} className="space-y-3 border-t border-border-default py-4">
                <h3 className="font-semibold">
                  {order.toBranchName} · {transferReference(transferId || orderId)}
                </h3>
                <Quiet>
                  {order.status.toLowerCase()} ·{' '}
                  {order.transferStatus?.toLowerCase().replaceAll('_', ' ') ?? 'Awaiting stock'}
                  {short > 0 ? ' · ' + short + ' units outstanding' : ''}
                </Quiet>
                {order.reservations.map((row) => (
                  <div
                    className="space-y-2 rounded-sm border border-border-subtle p-3"
                    key={row.id}
                  >
                    <div className="font-medium">
                      {row.productName} · {row.quantityUnits} units · {row.state.toLowerCase()}
                    </div>
                    <Quiet>
                      Batch {row.batchNumber ?? 'unrecorded'} · Shelf label {row.lotCode} · Source{' '}
                      {row.sourceBinCode} · Catalog ID {row.medicineId}
                      {row.stagingBinCode ? ' · Staging ' + row.stagingBinCode : ''}
                      {row.expiresAt
                        ? ' · Expires ' + new Date(row.expiresAt).toISOString().slice(0, 10)
                        : ''}
                    </Quiet>
                    {(row.state === 'RESERVED' || row.state === 'PICKED') && (
                      <ActionForm
                        key={row.state}
                        label={
                          row.state === 'RESERVED'
                            ? 'Confirm pick into staging'
                            : 'Confirm packed line'
                        }
                        success={
                          row.state === 'RESERVED' ? 'Pick recorded.' : 'Packed line recorded.'
                        }
                        action={(data, key) => {
                          const input = {
                            branchId,
                            reservationId: row.id,
                            productScan: read(data, 'product'),
                            lotScan: read(data, 'lot'),
                            stagingBinScan: read(data, 'stage'),
                            quantityUnits: Number(read(data, 'units')),
                            idempotencyKey: key,
                          };
                          return row.state === 'RESERVED'
                            ? pick.mutateAsync({ ...input, sourceBinScan: read(data, 'source') })
                            : pack.mutateAsync(input);
                        }}
                      >
                        {row.state === 'RESERVED' && (
                          <Field label="Source bin scan" name="source" scan />
                        )}
                        <Field label="Product barcode or catalog ID" name="product" scan />
                        <Field label="Lot shelf label" name="lot" scan />
                        <Field label="Staging bin scan" name="stage" scan />
                        <Field
                          label="Scanned base units"
                          name="units"
                          type="number"
                          min={1}
                          max={row.quantityUnits}
                        />
                      </ActionForm>
                    )}
                  </div>
                ))}
                {short > 0 && order.status === 'OPEN' && (
                  <ActionForm
                    label="Reserve available stock for shortfall"
                    success="Outstanding demand checked."
                    action={(_, key) =>
                      replenish.mutateAsync({ branchId, orderId, idempotencyKey: key })
                    }
                  />
                )}
                {transferId && order.transferStatus === 'ALLOCATED' && (
                  <ActionForm
                    label="Approve branch transfer"
                    success="Transfer approved."
                    action={(data) =>
                      approve.mutateAsync({
                        branchId,
                        transferId,
                        ...(read(data, 'pin') ? { soloPin: read(data, 'pin') } : {}),
                      })
                    }
                  >
                    <Field
                      name="pin"
                      type="password"
                      label="Solo owner PIN (if applicable)"
                      required={false}
                    />
                  </ActionForm>
                )}
                {transfer && SLIP_STATUSES.has(transfer.status) && (
                  <PackingSlipPrintButton slip={packingSlipFor(transfer)} />
                )}
                {transferId && ready && order.transferStatus === 'APPROVED' && (
                  <>
                    {live.some((row) => row.requiresTemperatureEvidence) && (
                      <ActionForm
                        label="Record dispatch temperature evidence"
                        success="Dispatch evidence recorded."
                        action={(data, key) =>
                          evidence.mutateAsync({
                            branchId,
                            transferId,
                            minimumC: read(data, 'min') ? Number(read(data, 'min')) : null,
                            maximumC: read(data, 'max') ? Number(read(data, 'max')) : null,
                            evidenceRef: read(data, 'evidence'),
                            requestKey: key,
                          })
                        }
                      >
                        <Field
                          name="min"
                          label="Minimum measured °C"
                          type="number"
                          step="any"
                          required={false}
                        />
                        <Field
                          name="max"
                          label="Maximum measured °C"
                          type="number"
                          step="any"
                          required={false}
                        />
                        <Field name="evidence" label="Logger record or evidence reference" />
                        <p className="col-span-full text-sm text-text-muted">
                          If readings are unavailable, leave both blank and record the reason as
                          evidence for quality review.
                        </p>
                      </ActionForm>
                    )}
                    <ActionForm
                      label="Confirm dispatch"
                      success={(result: { status: string }) =>
                        isDispatchHeld(result)
                          ? 'Dispatch held. Review temperature evidence in Quality before retrying.'
                          : 'Dispatch confirmed.'
                      }
                      action={(_, key) =>
                        dispatch.mutateAsync({ branchId, transferId, idempotencyKeyPrefix: key })
                      }
                    />
                  </>
                )}
                {order.status === 'OPEN' && (
                  <details>
                    <summary className="cursor-pointer text-sm text-text-muted">
                      Cancel outstanding work
                    </summary>
                    <div className="mt-2">
                      <ActionForm
                        destructive
                        label="Cancel outstanding work"
                        success="Unshipped reservations cancelled."
                        action={(data, key) =>
                          cancel.mutateAsync({
                            branchId,
                            orderId,
                            idempotencyKey: key,
                            reason: read(data, 'reason'),
                          })
                        }
                      >
                        <Field name="reason" label="Cancellation reason" />
                      </ActionForm>
                    </div>
                  </details>
                )}
              </article>
            );
          })
        )}
      </SectionCard>
      {!!board.data?.adoptable.length && (
        <SectionCard title="Transfers awaiting warehouse scans">
          {board.data.adoptable.map((t) => (
            <article key={t.id} className="space-y-2 border-t border-border-subtle py-3">
              <h3 className="font-semibold">
                {transferReference(t.id)} to {t.toBranchName}
              </h3>
              <ActionForm
                label="Reserve and start warehouse scans"
                success="Transfer moved to the pick queue."
                action={(_, key) =>
                  adopt.mutateAsync({ branchId, transferId: t.id, idempotencyKey: key })
                }
              />
            </article>
          ))}
        </SectionCard>
      )}
    </div>
  );
}
