'use client';

import { useState } from 'react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';
import { ActionForm, Choice, Field, Problem, Quiet, read } from './form';

type Setup = inferRouterOutputs<AppRouter>['pharmacyWarehouse']['setup'];

function Destination({
  setup,
  branchId,
  medicine,
}: {
  setup: Setup;
  branchId: string;
  medicine?: { controlled: boolean; coldChain: boolean };
}) {
  const bins = setup.locations.filter(
    (bin) =>
      !bin.warehouseStaging &&
      ['STORE', 'RACK_BIN', 'FRIDGE', 'SAFE'].includes(bin.kind) &&
      (!medicine?.controlled || bin.kind === 'SAFE') &&
      (!medicine?.coldChain || bin.coldChain)
  );
  return (
    <>
      <Choice
        name="warehouse"
        label={medicine?.controlled ? 'Warehouse handling the request' : 'Supply warehouse'}
      >
        {setup.warehouses
          .filter((site) => site.id !== branchId)
          .map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
      </Choice>
      <Choice name="bin" label="Receiving bin">
        {!bins.length && <option value="">Configure an eligible receiving bin</option>}
        {bins.map((bin) => (
          <option key={bin.id} value={bin.id}>
            {bin.code} · {bin.name}
          </option>
        ))}
      </Choice>
    </>
  );
}

export function BranchDemand({ branchId, setup }: { branchId: string; setup: Setup }) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const queue = trpc.pharmacyWarehouse.requestQueue.useQuery({ branchId });
  const catalog = trpc.pharmacyWarehouse.searchMedicines.useQuery(
    { branchId, query: search.trim() },
    { enabled: search.trim().length >= 2 }
  );
  const medicine = catalog.data?.find((row) => row.id === selectedId) ?? catalog.data?.[0];
  const submit = trpc.pharmacyWarehouse.submitRequest.useMutation();
  const fulfill = trpc.pharmacyWarehouse.fulfillRequest.useMutation();
  const withdraw = trpc.pharmacyWarehouse.withdrawRequest.useMutation();
  const purchase = trpc.pharmacyWarehouse.purchaseRequest.useMutation();
  const canRequest = setup.warehouses.some((site) => site.id !== branchId);
  function request(data: FormData, key: string, medicineId: string, signalId?: string) {
    return submit.mutateAsync({
      branchId,
      warehouseBranchId: read(data, 'warehouse'),
      destinationStockLocationId: read(data, 'bin'),
      medicineId,
      requestedUnits: Number(read(data, 'units')),
      ...(signalId ? { signalId } : {}),
      idempotencyKey: key,
    });
  }
  return (
    <div className="space-y-4">
      <SectionCard title="Branch replenishment requests">
        {queue.error ? (
          <Problem error={queue.error} retry={() => void queue.refetch()} />
        ) : !queue.data ? (
          <p role="status">Loading requests…</p>
        ) : !queue.data.requests.length ? (
          <Quiet>No requests for this site yet.</Quiet>
        ) : (
          queue.data.requests.map((row) => (
            <article key={row.id} className="space-y-2 border-t border-border-subtle py-3">
              <h3 className="font-semibold">
                {row.medicineName} · {row.requestedUnits} units
              </h3>
              <Quiet>
                {row.branchName} · {row.status.toLowerCase().replaceAll('_', ' ')}
                {row.availableToPromiseUnits != null &&
                  ' · ' + row.availableToPromiseUnits + ' units available to promise'}
              </Quiet>
              {row.status === 'REQUESTED' && row.warehouseBranchId === branchId && (
                <ActionForm
                  label="Approve and reserve stock"
                  success="Request approved. Available units reserved."
                  action={() => fulfill.mutateAsync({ branchId, requestId: row.id })}
                />
              )}
              {row.status === 'DIRECT_PURCHASE' &&
                row.branchId === branchId &&
                (setup.canPurchase ? (
                  <ActionForm
                    label="Create supplier requisition"
                    success="Direct supplier requisition created."
                    action={() => purchase.mutateAsync({ branchId, requestId: row.id })}
                  />
                ) : (
                  <Quiet>
                    Branch purchasing can create a direct supplier requisition for this controlled
                    medicine.
                  </Quiet>
                ))}
              {(row.status === 'REQUESTED' || row.status === 'DIRECT_PURCHASE') && (
                <ActionForm
                  label="Withdraw request"
                  success="Request withdrawn."
                  action={() => withdraw.mutateAsync({ branchId, requestId: row.id })}
                />
              )}
              {row.requisitionId && row.branchId === branchId && setup.canPurchase && (
                <Link
                  className={buttonVariants({ variant: 'outline' })}
                  href={
                    '/pharmacy/purchasing/orders?' +
                    new URLSearchParams({ branch: branchId, req: row.requisitionId })
                  }
                >
                  Open direct supplier requisition
                </Link>
              )}
            </article>
          ))
        )}
      </SectionCard>
      {canRequest && (
        <SectionCard title="Request stock">
          <label className="mb-3 grid max-w-md gap-1 text-sm">
            Find a medicine
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Type at least two characters"
              className="min-h-11"
            />
          </label>
          {catalog.error ? (
            <Problem error={catalog.error} />
          ) : search.trim().length >= 2 && !catalog.data ? (
            <p role="status">Searching medicines…</p>
          ) : catalog.data?.length && medicine ? (
            <ActionForm
              label="Submit request"
              success="Branch request submitted."
              action={(data, key) => request(data, key, read(data, 'medicine'))}
            >
              <label className="grid min-w-0 gap-1 text-sm text-text-body">
                Medicine
                <SelectField
                  className="min-h-11"
                  name="medicine"
                  value={medicine.id}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {catalog.data.map((medicine) => (
                    <option key={medicine.id} value={medicine.id}>
                      {medicine.productName}
                      {medicine.controlled ? ' · direct supplier delivery' : ''}
                    </option>
                  ))}
                </SelectField>
              </label>
              <Field name="units" label="Requested base units" type="number" min={1} />
              <Destination
                key={medicine.id}
                branchId={branchId}
                setup={setup}
                medicine={medicine}
              />
            </ActionForm>
          ) : search.trim().length >= 2 ? (
            <Quiet>No matching medicines.</Quiet>
          ) : null}
        </SectionCard>
      )}
      {!!queue.data?.suggestions.length && canRequest && (
        <SectionCard title="Stock shortage suggestions">
          {queue.data.suggestions.map((signal) => (
            <article key={signal.id} className="space-y-2 border-t border-border-subtle py-3">
              <h3 className="font-semibold">{signal.medicineName}</h3>
              <ActionForm
                label="Submit suggested request"
                success="Suggestion submitted for fulfillment."
                action={(data, key) => request(data, key, signal.medicineId, signal.id)}
              >
                <Field
                  name="units"
                  label="Requested base units"
                  type="number"
                  min={1}
                  value={signal.neededUnits}
                />
                <Destination branchId={branchId} setup={setup} />
              </ActionForm>
            </article>
          ))}
        </SectionCard>
      )}
      {!canRequest && !setup.enabled && (
        <Quiet>
          A warehouse must be configured at another site before this branch can request
          replenishment.
        </Quiet>
      )}
    </div>
  );
}
