'use client';

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
import { Stat } from '@/components/ui/stat';
import { SectionCard } from '@/components/ui/section-card';
import { transferReference } from '@/components/pharmacy/inventory/transfers/transfer-presentation';
import { ActionForm, Choice, Field, Problem, Quiet, read } from './form';

const percent = (n: number | null) => (n == null ? '—' : n.toFixed(1) + '%');

export function WarehouseOverview({ branchId }: { branchId: string }) {
  const board = trpc.pharmacyWarehouse.overview.useQuery({ branchId });
  const setup = trpc.pharmacyWarehouse.setup.useQuery({ branchId });
  const [noticeId, setNoticeId] = useState('');
  if (board.error) return <Problem error={board.error} retry={() => void board.refetch()} />;
  if (!board.data) return <p role="status">Loading warehouse overview…</p>;
  const { metrics, shortages, overdue, qualityHolds, recalls, overdueAfterHours } = board.data;
  return (
    <div className="space-y-4">
      <div
        aria-label="Warehouse metrics over the last 30 days"
        className="grid grid-cols-2 gap-3 xl:grid-cols-5"
      >
        <Stat
          label="Branch fill rate"
          value={percent(metrics.fillRate.percent)}
          sub="Units received / units requested · 30 days"
        />
        <Stat
          label="Request to receipt"
          value={
            metrics.receiptTime.averageHours == null
              ? '—'
              : metrics.receiptTime.averageHours.toFixed(1) + ' h'
          }
          sub="Completed shipments · last 30 days"
        />
        <Stat
          label="Bin count accuracy"
          value={percent(metrics.binAccuracy.percent)}
          sub="Approved count lines · last 30 days"
        />
        <Stat
          label="Expiry write-offs"
          value={metrics.expiryWriteOffUnits}
          sub="Units · last 30 days"
        />
        <Stat label="Transfer discrepancies" value={metrics.openExceptions} sub="Currently open" />
      </div>
      <SectionCard title="Outstanding branch demand">
        {shortages.length ? (
          <ul className="divide-y divide-border-subtle">
            {shortages.map((row) => (
              <li className="py-2" key={row.demandId}>
                {row.toBranchName} · {row.medicineName} · {row.shortfallUnits} of{' '}
                {row.requestedUnits} units outstanding
              </li>
            ))}
          </ul>
        ) : (
          <Quiet>No outstanding warehouse demand for this site.</Quiet>
        )}
      </SectionCard>
      <SectionCard title="Overdue transfers">
        {overdue.length ? (
          <ul className="divide-y divide-border-subtle">
            {overdue.map((row) => (
              <li className="py-2" key={row.id}>
                {transferReference(row.id)} · {row.fromBranchName} → {row.toBranchName} ·{' '}
                {row.lines.reduce((sum, l) => sum + l.quantityUnits - l.receivedUnits, 0)} units
                outstanding
              </li>
            ))}
          </ul>
        ) : (
          <Quiet>No shipments have been in transit for more than {overdueAfterHours} hours.</Quiet>
        )}
      </SectionCard>
      <SectionCard title="Quality holds and recalls">
        {qualityHolds.length ? (
          <ul className="divide-y divide-border-subtle">
            {qualityHolds.map((row) => (
              <li
                className="py-2"
                key={[row.inventoryLotId, row.stockLocationId, row.disposition].join(':')}
              >
                {row.medicineName} · Batch {row.batchNumber ?? 'unrecorded'} · {row.binCode} ·{' '}
                {row.units} units · {row.reason}
              </li>
            ))}
          </ul>
        ) : (
          <Quiet>No held stock at this site.</Quiet>
        )}
        {recalls.map((row) => (
          <div
            key={row.id}
            className="mt-3 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3"
          >
            <strong>{row.reference}</strong>
            <span>
              {row.reason} ·{' '}
              {row.acknowledged ? 'Site acknowledged' : 'Awaiting site acknowledgement'}
            </span>
            {setup.data?.canReview && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setNoticeId(noticeId === row.id ? '' : row.id)}
              >
                {noticeId === row.id ? 'Close trace' : 'Trace recall'}
              </Button>
            )}
            {noticeId === row.id && <RecallTrace branchId={branchId} noticeId={noticeId} />}
          </div>
        ))}
        <Link
          href={'/pharmacy/inventory?branch=' + encodeURIComponent(branchId)}
          className={buttonVariants({ variant: 'outline', className: 'mt-3' })}
        >
          Open inventory counts and recalls
        </Link>
      </SectionCard>
    </div>
  );
}

function RecallTrace({ branchId, noticeId }: { branchId: string; noticeId: string }) {
  const trace = trpc.pharmacyWarehouse.recallTrace.useQuery({ branchId, noticeId });
  const sites = trpc.pharmacyWarehouse.sites.useQuery();
  const names = new Map(sites.data?.map((site) => [site.id, site.name]));
  const name = (id: string) => names.get(id) ?? id;
  if (trace.error) return <Problem error={trace.error} />;
  if (!trace.data) return <p role="status">Tracing the batch…</p>;
  return (
    <div className="basis-full space-y-2 rounded-sm bg-surface-sunken p-3 text-sm">
      {trace.data.receipts.map((row) => (
        <p key={row.inventoryLotId}>
          {name(row.branchId)} · Supplier {row.supplierName} · Receipt {row.receiptReference} ·{' '}
          {row.receivedUnits} units received
        </p>
      ))}
      {trace.data.bins.map((row) => (
        <p key={[row.inventoryLotId, row.stockLocationId, row.disposition].join(':')}>
          {name(row.branchId)} · {row.binCode} · {row.onHandUnits} units{' '}
          {row.disposition.toLowerCase().replaceAll('_', ' ')}
        </p>
      ))}
      {trace.data.shipments.map((row) => (
        <p key={row.transferLineId}>
          {transferReference(row.transferId)} · {name(row.fromBranchId)} → {name(row.toBranchId)} ·{' '}
          {row.dispatchedUnits} dispatched · {row.receivedUnits} received · {row.inTransitUnits} in
          transit · {row.shortClosedUnits} shortage closed
        </p>
      ))}
      {trace.data.sales.map((row) => (
        <p key={row.inventoryLotId}>
          {name(row.branchId)} · Lot {row.inventoryLotId} · {row.netSoldUnits} net sold
        </p>
      ))}
      {trace.data.returns.map((row) => (
        <p key={row.inventoryLotId}>
          {name(row.branchId)} · Lot {row.inventoryLotId} · {row.returnedUnits} units returned
        </p>
      ))}
      {!trace.data.shipments.length && (
        <Quiet>No shipments in the accessible branches for this recall.</Quiet>
      )}
    </div>
  );
}

export function Arrivals({ branchId }: { branchId: string }) {
  const board = trpc.pharmacyWarehouse.overview.useQuery({ branchId });
  const receive = trpc.pharmacyInventory.receiveTransferLine.useMutation();
  if (board.error) return <Problem error={board.error} />;
  return (
    <SectionCard title="Receive branch shipments">
      {!board.data ? (
        <p role="status">Loading shipments…</p>
      ) : !board.data.incoming.length ? (
        <Quiet>No warehouse shipments are awaiting receipt.</Quiet>
      ) : (
        board.data.incoming.map((row) => (
          <article key={row.id} className="space-y-3 border-t border-border-default py-4">
            <h3 className="font-semibold">
              {transferReference(row.id)} · From {row.fromBranchName}
            </h3>
            {row.lines
              .filter((line) => line.quantityUnits > line.receivedUnits)
              .map((line) => {
                const remaining = line.quantityUnits - line.receivedUnits;
                return (
                  <div
                    key={line.id}
                    className="space-y-2 rounded-sm border border-border-subtle p-3"
                  >
                    <div className="font-medium">
                      {line.medicineName} · {remaining} units outstanding
                    </div>
                    <Quiet>
                      Batch {line.batchNumber ?? 'unrecorded'} · Shelf label {line.lotLabel} ·
                      Destination bin {line.destinationBinCode} · Catalog ID {line.medicineId}
                    </Quiet>
                    <ActionForm
                      label="Confirm receipt"
                      success="Receipt recorded. Outstanding units remain in transit."
                      action={(data, key) => {
                        const receivedUnits = Number(read(data, 'physical')),
                          damagedUnits = Number(read(data, 'damaged'));
                        if (damagedUnits > receivedUnits)
                          throw new Error('Damaged units must be included in the physical count.');
                        const min = read(data, 'min'),
                          max = read(data, 'max'),
                          ref = read(data, 'evidence');
                        if ((min || max || ref) && (!min || !max || !ref))
                          throw new Error(
                            'Enter both temperature readings and their evidence reference, or leave all three blank to record missing evidence.'
                          );
                        return receive.mutateAsync({
                          branchId,
                          transferId: row.id,
                          lineId: line.id,
                          receivedUnits,
                          damagedUnits,
                          productScan: read(data, 'product'),
                          lotScan: read(data, 'lot'),
                          binScan: read(data, 'bin'),
                          idempotencyKeyPrefix: key,
                          ...(min && max && ref
                            ? {
                                transportEvidence: {
                                  minimumC: Number(min),
                                  maximumC: Number(max),
                                  evidenceRef: ref,
                                },
                              }
                            : {}),
                        });
                      }}
                    >
                      <Field label="Product barcode or catalog ID" name="product" scan />
                      <Field label="Source lot shelf label" name="lot" scan />
                      <Field label="Destination bin code" name="bin" scan />
                      <Field
                        label="Physical units received (including damage)"
                        name="physical"
                        type="number"
                        min={1}
                        max={remaining}
                      />
                      <Field
                        label="Damaged units"
                        name="damaged"
                        type="number"
                        min={0}
                        max={remaining}
                        value={0}
                      />
                      {line.coldChain && (
                        <>
                          <Field
                            label="Transit minimum °C"
                            name="min"
                            type="number"
                            step="any"
                            required={false}
                          />
                          <Field
                            label="Transit maximum °C"
                            name="max"
                            type="number"
                            step="any"
                            required={false}
                          />
                          <Field
                            label="Transit evidence reference"
                            name="evidence"
                            required={false}
                          />
                          <p className="col-span-full text-sm text-text-muted">
                            Missing temperature evidence sends received stock to quality review.
                          </p>
                        </>
                      )}
                    </ActionForm>
                    <details>
                      <summary className="cursor-pointer text-sm text-text-muted">
                        Report missing delivery
                      </summary>
                      <div className="mt-2">
                        <ActionForm
                          label="Report zero units received"
                          success="Missing delivery recorded."
                          action={(_, key) =>
                            receive.mutateAsync({
                              branchId,
                              transferId: row.id,
                              lineId: line.id,
                              receivedUnits: 0,
                              idempotencyKeyPrefix: key,
                            })
                          }
                        />
                      </div>
                    </details>
                  </div>
                );
              })}
            {row.status === 'EXCEPTION' && (
              <Link
                className={buttonVariants({ variant: 'outline' })}
                href={`/pharmacy/inventory/transfers?branch=${encodeURIComponent(branchId)}#transfer-${encodeURIComponent(row.id)}`}
              >
                Close reported shortage with a witness
              </Link>
            )}
          </article>
        ))
      )}
    </SectionCard>
  );
}

export function QualityReview({
  branchId,
  canReview,
  canOperateStock = true,
}: {
  branchId: string;
  canReview: boolean;
  canOperateStock?: boolean;
}) {
  const queue = trpc.pharmacyWarehouse.quality.useQuery({ branchId });
  const review = trpc.pharmacyWarehouse.reviewQuality.useMutation();
  return (
    <div className="space-y-4">
      <SectionCard title="Quality review queue">
        {queue.error ? (
          <Problem error={queue.error} retry={() => void queue.refetch()} />
        ) : !queue.data ? (
          <p role="status">Loading quality incidents…</p>
        ) : !queue.data.length ? (
          <Quiet>No recorded warehouse quality incidents.</Quiet>
        ) : (
          queue.data.map((row) => (
            <article key={row.id} className="space-y-2 border-t border-border-subtle py-3">
              <h3 className="font-semibold">
                {row.productName} · {row.quantityUnits} units · {row.status.toLowerCase()}
              </h3>
              <Quiet>
                Batch {row.batchNumber ?? 'unrecorded'} · {row.binCode} · {row.reason}
              </Quiet>
              {row.status === 'OPEN' && canReview && (
                <ActionForm
                  label="Record quality decision"
                  success="Quality decision recorded."
                  action={(data) => {
                    const decision = read(data, 'decision');
                    if (decision !== 'RELEASE' && decision !== 'RETURN' && decision !== 'DISPOSE')
                      throw new Error('Select a quality decision.');
                    return review.mutateAsync({
                      branchId,
                      incidentId: row.id,
                      destinationBinCode:
                        decision === 'RELEASE' ? read(data, 'releaseBin') || undefined : undefined,
                      decision,
                      reason: read(data, 'reason'),
                      evidenceRef: read(data, 'evidence'),
                    });
                  }}
                >
                  <Choice label="Disposition" name="decision">
                    <option value="">Select a decision</option>
                    <option value="RELEASE">Release stock</option>
                    <option value="RETURN">Authorize supplier return</option>
                    <option value="DISPOSE">Authorize disposal</option>
                  </Choice>
                  {row.requiresReleaseBin && (
                    <Field
                      name="releaseBin"
                      label="Storage bin scan for release"
                      scan
                      required={false}
                    />
                  )}
                  <Field name="reason" label="Decision rationale" />
                  <Field name="evidence" label="Supporting evidence reference" />
                </ActionForm>
              )}
              {row.status === 'RETURN' && canOperateStock && (
                <Link
                  className={buttonVariants({ variant: 'outline' })}
                  href={'/pharmacy/purchasing/returns?branch=' + encodeURIComponent(branchId)}
                >
                  Open supplier returns to record dispatch
                </Link>
              )}
              {row.status === 'DISPOSE' && canOperateStock && (
                <Link
                  className={buttonVariants({ variant: 'outline' })}
                  href={'/pharmacy/inventory?branch=' + encodeURIComponent(branchId)}
                >
                  Record witnessed write-off in inventory
                </Link>
              )}
              {row.reviewReason && (
                <Quiet>
                  {row.reviewReason} · {row.reviewEvidenceRef}
                </Quiet>
              )}
            </article>
          ))
        )}
      </SectionCard>
      {canReview && <Temperatures branchId={branchId} />}
    </div>
  );
}

function Temperatures({ branchId }: { branchId: string }) {
  const [search, setSearch] = useState('');
  const catalog = trpc.pharmacyWarehouse.searchMedicines.useQuery(
    { branchId, query: search.trim() },
    { enabled: search.trim().length >= 2 }
  );
  const propose = trpc.pharmacyWarehouse.proposeProductTemperatures.useMutation();
  const access = trpc.pharmacyMedicine.catalogueQueueAccess.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const [lastProposal, setLastProposal] = useState<{
    medicineId: string;
    proposalId: string;
  } | null>(null);
  const [medicineId, setMedicineId] = useState('');
  const coldMedicines = catalog.data?.filter((medicine) => medicine.coldChain) ?? [];
  const selected = coldMedicines.find((medicine) => medicine.id === medicineId) ?? coldMedicines[0];
  return (
    <SectionCard title="Labelled product temperatures">
      <label className="mb-3 grid max-w-md gap-1 text-sm">
        Find a cold-chain medicine
        <Input
          className="min-h-11"
          placeholder="Type at least two characters"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {catalog.error ? (
        <Problem error={catalog.error} />
      ) : search.trim().length >= 2 && !catalog.data ? (
        <p role="status">Loading medicines…</p>
      ) : search.trim().length >= 2 && !selected ? (
        <Quiet>No matching cold-chain medicine.</Quiet>
      ) : null}
      {selected && (
        <>
          <label className="mb-3 grid max-w-md gap-1 text-sm">
            Medicine
            <SelectField
              className="min-h-11"
              value={selected.id}
              onChange={(event) => setMedicineId(event.target.value)}
            >
              {coldMedicines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.productName}
                </option>
              ))}
            </SelectField>
          </label>
          <p className="mb-3 text-sm text-text-muted">
            {selected.minimumStorageTemperatureC == null ||
            selected.maximumStorageTemperatureC == null
              ? 'This medicine has no approved storage range.'
              : `The approved storage range is ${selected.minimumStorageTemperatureC} °C to ${selected.maximumStorageTemperatureC} °C.`}{' '}
            Changes apply to every branch after catalogue approval.
          </p>
          <ActionForm
            key={[
              selected.id,
              selected.minimumStorageTemperatureC,
              selected.maximumStorageTemperatureC,
            ].join(':')}
            label="Submit temperature range for review"
            success="Temperature proposal submitted for catalogue review."
            action={async (data) => {
              const proposal = await propose.mutateAsync({
                branchId,
                medicineId: selected.id,
                minimumC: Number(read(data, 'min')),
                maximumC: Number(read(data, 'max')),
              });
              setLastProposal({ medicineId: selected.id, proposalId: proposal.proposalId });
              await utils.pharmacyMedicine.catalogueEdits.invalidate();
            }}
          >
            <Field
              name="min"
              label="Proposed minimum °C"
              type="number"
              step="any"
              value={selected.minimumStorageTemperatureC ?? undefined}
            />
            <Field
              name="max"
              label="Proposed maximum °C"
              type="number"
              step="any"
              value={selected.maximumStorageTemperatureC ?? undefined}
            />
          </ActionForm>
          {lastProposal?.medicineId === selected.id && access.data?.canDecide && (
            <Link
              className={buttonVariants({ variant: 'outline', className: 'mt-3' })}
              href={
                '/pharmacy/medicines#catalogue-edit-' + encodeURIComponent(lastProposal.proposalId)
              }
            >
              Open submitted proposal in catalogue review
            </Link>
          )}
        </>
      )}
    </SectionCard>
  );
}
