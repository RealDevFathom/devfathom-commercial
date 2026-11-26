'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { BranchAssignmentRequired } from '@/components/pharmacy/inventory/branch-assignment-required';
import { SectionCard } from '@/components/ui/section-card';
import { Button, buttonVariants } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { trpc } from '@/lib/trpc';
import { ActionForm, Field, Problem, Quiet, read, WarehouseFeedback } from './form';
import { BranchDemand } from './requests';
import { Outbound } from './outbound';
import { Arrivals, QualityReview, WarehouseOverview } from './supervision';

const tabs = [
  'Overview',
  'Requests',
  'Put-away',
  'Pick and pack',
  'Arrivals',
  'Quality',
  'Setup',
] as const;
type Tab = (typeof tabs)[number];

export function WarehouseWorkspace({ initialBranchId }: { initialBranchId?: string }) {
  const sites = trpc.pharmacyWarehouse.sites.useQuery();
  const { data: session } = useSession();
  const [selection, setSelection] = useState(initialBranchId ?? '');
  if (sites.error)
    return (
      <SectionCard title="Warehouse access">
        <Problem error={sites.error} retry={() => void sites.refetch()} />
      </SectionCard>
    );
  if (!sites.data) return <p role="status">Loading warehouse sites…</p>;
  const site = sites.data.find((row) => row.id === selection) ?? sites.data[0];
  if (!site) return <BranchAssignmentRequired canAssign={session?.user?.role === 'ADMIN'} />;
  return (
    <div className="space-y-4">
      <label className="grid max-w-md gap-1 text-sm text-text-body">
        Working site
        <SelectField
          className="min-h-11"
          value={site.id}
          onChange={(event) => setSelection(event.target.value)}
        >
          {sites.data.map((row) => (
            <option value={row.id} key={row.id}>
              {row.name}
              {row.warehouseEnabled ? ' · central warehouse' : ''}
            </option>
          ))}
        </SelectField>
      </label>
      <WarehouseFeedback key={site.id}>
        {site.accessMode === 'inventory' ? (
          <Site branchId={site.id} />
        ) : site.accessMode === 'quality' ? (
          <QualityReview branchId={site.id} canReview canOperateStock={false} />
        ) : (
          <SectionCard title="Warehouse access">
            <Quiet>Refresh this page to check your warehouse access.</Quiet>
          </SectionCard>
        )}
      </WarehouseFeedback>
    </div>
  );
}

function Site({ branchId }: { branchId: string }) {
  const [view, setView] = useState<Tab>('Overview');
  const setup = trpc.pharmacyWarehouse.setup.useQuery({ branchId });
  if (setup.error) return <Problem error={setup.error} retry={() => void setup.refetch()} />;
  const config = setup.data;
  if (!config) return <p role="status">Loading site configuration…</p>;
  const options = tabs.filter((tab) => {
    if (tab === 'Setup') return config.canConfigure;
    if (tab === 'Put-away' || tab === 'Pick and pack') return config.enabled;
    return true;
  });
  const selected = options.includes(view) ? view : 'Overview';
  return (
    <div className="space-y-4">
      <nav aria-label="Warehouse workflows" className="flex flex-wrap gap-2">
        {options.map((tab) => (
          <Button
            key={tab}
            className="min-h-11"
            type="button"
            aria-current={tab === selected ? 'page' : undefined}
            variant={tab === selected ? 'default' : 'outline'}
            onClick={() => setView(tab)}
          >
            {tab}
          </Button>
        ))}
      </nav>
      {selected === 'Overview' && <WarehouseOverview branchId={branchId} />}
      {selected === 'Requests' && <BranchDemand branchId={branchId} setup={config} />}
      {selected === 'Put-away' && <PutAway branchId={branchId} />}
      {selected === 'Pick and pack' && <Outbound branchId={branchId} />}
      {selected === 'Arrivals' && <Arrivals branchId={branchId} />}
      {selected === 'Quality' && (
        <QualityReview
          branchId={branchId}
          canReview={config.canReview}
          canSupplierReturn={config.canSupplierReturn}
        />
      )}
      {selected === 'Setup' && <WarehouseSetup branchId={branchId} />}
    </div>
  );
}

function PutAway({ branchId }: { branchId: string }) {
  const tasks = trpc.pharmacyWarehouse.putAwayTasks.useQuery({ branchId });
  const complete = trpc.pharmacyWarehouse.completePutAway.useMutation();
  return (
    <SectionCard
      title="Put-away queue"
      actions={
        <Link
          className={buttonVariants({ variant: 'outline' })}
          href={'/pharmacy/purchasing/receiving?branch=' + encodeURIComponent(branchId)}
        >
          Receive delivery
        </Link>
      }
    >
      {tasks.error ? (
        <Problem error={tasks.error} retry={() => void tasks.refetch()} />
      ) : !tasks.data ? (
        <p role="status">Loading put-away tasks…</p>
      ) : tasks.data.length === 0 ? (
        <Quiet>No supplier receipt lines are waiting for put-away.</Quiet>
      ) : (
        tasks.data.map((task) => (
          <article key={task.id} className="space-y-3 border-t border-border-subtle py-4">
            <h3 className="font-semibold">
              {task.medicineName} · {task.quantityUnits} units
            </h3>
            <Quiet>
              Receipt {task.receiptReference} · Batch {task.batchNumber} · From{' '}
              {task.sourceLocationCode} · Catalog ID {task.medicineId}
            </Quiet>
            <ActionForm
              label="Confirm put-away"
              success="Put-away recorded."
              action={(data) =>
                complete.mutateAsync({
                  branchId,
                  taskId: task.id,
                  productScan: read(data, 'productScan'),
                  batchScan: read(data, 'batchScan'),
                  destinationCode: read(data, 'destinationCode'),
                  quantityUnits: Number(read(data, 'quantityUnits')),
                })
              }
            >
              <Field name="productScan" label="Product barcode or catalog ID" scan />
              <Field name="batchScan" label="Batch number" scan />
              <Field name="destinationCode" label="Destination bin code" scan />
              <Field
                name="quantityUnits"
                label="Units put away"
                type="number"
                min={1}
                max={task.quantityUnits}
              />
            </ActionForm>
          </article>
        ))
      )}
    </SectionCard>
  );
}

function WarehouseSetup({ branchId }: { branchId: string }) {
  const query = trpc.pharmacyWarehouse.setup.useQuery({ branchId });
  const configure = trpc.pharmacyWarehouse.configure.useMutation();
  const row = query.data;
  if (!row)
    return query.error ? <Problem error={query.error} /> : <p role="status">Loading settings…</p>;
  return (
    <SectionCard title="Site configuration">
      <ActionForm
        key={JSON.stringify([
          row.enabled,
          row.minimumShelfLifeDays,
          row.locations.map((l) => l.warehouseStaging),
        ])}
        label="Save configuration"
        success="Warehouse settings saved."
        action={(data) =>
          configure.mutateAsync({
            branchId,
            enabled: data.has('enabled'),
            minimumShelfLifeDays: Number(read(data, 'minimum')),
            stagingLocationIds: data.getAll('staging').map(String),
          })
        }
      >
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input name="enabled" type="checkbox" defaultChecked={row.enabled} /> Operate as a
          warehouse
        </label>
        <Field
          name="minimum"
          label="Minimum remaining shelf life at delivery (days)"
          type="number"
          min={0}
          value={row.minimumShelfLifeDays}
        />
        <fieldset className="col-span-full grid gap-2 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium">Staging bins for packed orders</legend>
          <p className="col-span-full text-sm text-text-muted">
            Choose empty bins. Refrigerated products need a refrigerated staging bin.
          </p>
          {row.locations
            .filter((l) => ['RACK_BIN', 'STORE', 'FRIDGE'].includes(l.kind))
            .map((l) => (
              <label className="flex min-h-11 items-center gap-2 text-sm" key={l.id}>
                <input
                  name="staging"
                  type="checkbox"
                  defaultChecked={l.warehouseStaging}
                  value={l.id}
                />
                {l.name} · {l.code}
                {l.coldChain ? ' · refrigerated' : ''}
              </label>
            ))}
        </fieldset>
      </ActionForm>
      <Link
        className={buttonVariants({ className: 'mt-3 me-2', variant: 'outline' })}
        href={'/pharmacy/inventory?branch=' + encodeURIComponent(branchId)}
      >
        Manage storage bins
      </Link>
      <Link
        className={buttonVariants({ className: 'mt-3', variant: 'outline' })}
        href={'/pharmacy/inventory/transfers?branch=' + encodeURIComponent(branchId)}
      >
        Manage branch transfer policy
      </Link>
    </SectionCard>
  );
}
