'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

const fields = {
  productName: 'Product name',
  brandName: 'Brand',
  manufacturer: 'Manufacturer',
  marketingAuthorizationHolder: 'Marketing authorization holder',
  drapRegistrationNumber: 'DRAP registration number',
  drapRegistrationStatus: 'DRAP registration status',
  rx: 'Prescription required',
  otc: 'Over the counter',
  restricted: 'Restricted',
  controlled: 'Controlled',
  highAlert: 'High alert',
  lasa: 'Look-alike / sound-alike',
  coldChain: 'Cold chain',
  retailPriceMinor: 'Retail price (minor units)',
  retailCategory: 'Retail category',
} as const;
type Field = keyof typeof fields;
const flags = new Set<Field>([
  'rx',
  'otc',
  'restricted',
  'controlled',
  'highAlert',
  'lasa',
  'coldChain',
]);

export function CatalogueEditQueue({ canEdit = true }: { canEdit?: boolean }) {
  const [query, setQuery] = useState('');
  const [medicine, setMedicine] = useState<{ id: string; productName: string } | null>(null);
  const [field, setField] = useState<Field>('productName');
  const [value, setValue] = useState('');
  const [pins, setPins] = useState<Record<string, string>>({});
  const utils = trpc.useUtils();
  const search = trpc.pharmacyMedicine.search.useQuery(
    { query: query || ' ', limit: 10 },
    { enabled: canEdit && query.trim().length > 0, retry: false }
  );
  const queue = trpc.pharmacyMedicine.catalogueEdits.useQuery(undefined, { retry: false });
  const submit = trpc.pharmacyMedicine.submitCatalogueEdit.useMutation({
    onSuccess: async () => {
      toast.success('Edit queued for review.');
      setValue('');
      await utils.pharmacyMedicine.catalogueEdits.invalidate();
    },
  });
  const decide = trpc.pharmacyMedicine.decideCatalogueEdit.useMutation({
    onSuccess: async () => {
      toast.success('Catalogue decision recorded.');
      await Promise.all([
        utils.pharmacyMedicine.catalogueEdits.invalidate(),
        utils.pharmacyMedicine.search.invalidate(),
      ]);
    },
  });
  const valueInvalid = submit.error?.data?.code === 'BAD_REQUEST';
  return (
    <SectionCard title="Catalogue edits" titleLevel={2}>
      <p className="mb-4 text-sm text-text-muted">
        Edits stay pending until reviewed. The editor cannot approve their own edit unless they are
        a solo owner and enter a fresh PIN.
      </p>
      {canEdit && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!medicine) return;
            const next = flags.has(field)
              ? value === 'true'
              : field === 'retailPriceMinor'
                ? value
                  ? Number(value)
                  : null
                : value || null;
            submit.mutate({ medicineId: medicine.id, changes: { [field]: next } });
          }}
        >
          <label className="block text-sm">
            Find a catalogue item
            <Input
              className="mt-2 min-h-11"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMedicine(null);
              }}
            />
          </label>
          {search.isFetching && <p role="status">Searching catalogue…</p>}
          {search.error && (
            <p role="alert" className="text-sm text-destructive">
              {search.error.message}
            </p>
          )}
          {query.trim() && search.data?.length === 0 && (
            <p className="text-sm text-text-muted">No matching items. Try another name.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {search.data?.map((item) => (
              <Button
                className="min-h-11"
                type="button"
                key={item.id}
                variant="outline"
                aria-pressed={medicine?.id === item.id}
                onClick={() => setMedicine(item)}
              >
                {item.productName}
              </Button>
            ))}
          </div>
          {medicine && <p className="text-sm">Editing {medicine.productName}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              Field
              <select
                className="mt-2 min-h-11 w-full rounded-sm border border-border bg-surface-card px-3"
                value={field}
                onChange={(event) => {
                  setField(event.target.value as Field);
                  setValue('');
                }}
              >
                {Object.entries(fields).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Proposed value
              {flags.has(field) ? (
                <select
                  required
                  aria-invalid={valueInvalid}
                  aria-describedby={submit.error ? 'catalogue-edit-error' : undefined}
                  className="mt-2 min-h-11 w-full rounded-sm border border-border bg-surface-card px-3"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                >
                  <option value="">Select a value</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : (
                <Input
                  className="mt-2 min-h-11"
                  aria-invalid={valueInvalid}
                  aria-describedby={submit.error ? 'catalogue-edit-error' : undefined}
                  required={field === 'productName'}
                  type={field === 'retailPriceMinor' ? 'number' : 'text'}
                  min={1}
                  step={1}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
            </label>
          </div>
          {submit.error && (
            <p id="catalogue-edit-error" role="alert" className="text-sm text-destructive">
              {submit.error.message}
            </p>
          )}
          <Button className="min-h-11" type="submit" disabled={!medicine || submit.isPending}>
            {submit.isPending ? 'Submitting…' : 'Submit for review'}
          </Button>
        </form>
      )}
      <div className="mt-6 space-y-4" aria-label="Pending catalogue edits">
        {queue.isPending && <p role="status">Loading pending edits…</p>}
        {queue.error && (
          <div role="alert">
            <p className="text-sm text-destructive">
              {queue.error.data?.code === 'FORBIDDEN'
                ? 'Catalogue review permission is required to view and decide edits.'
                : queue.error.message}
            </p>
            <Button className="min-h-11" variant="outline" onClick={() => void queue.refetch()}>
              Retry queue
            </Button>
          </div>
        )}
        {queue.data?.length === 0 && (
          <p className="text-sm text-text-muted">No catalogue edits await review.</p>
        )}
        {decide.isPending && (
          <p role="status" className="text-sm text-text-muted">
            Saving catalogue decision…
          </p>
        )}
        {decide.error && (
          <p role="alert" className="text-sm text-destructive">
            {decide.error.message}
          </p>
        )}
        {queue.data?.map((edit) => (
          <article
            key={edit.id}
            className="min-w-0 space-y-3 rounded-md border border-border-subtle p-4"
          >
            <div className="flex flex-wrap justify-between gap-3">
              <h3 className="font-semibold">{edit.medicine.productName}</h3>
              <StatusPill status="Pending review" tone="warning" />
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              {Object.entries(edit.changes as Record<string, unknown>).map(([key, next]) => (
                <div key={key} className="min-w-0 rounded-sm bg-surface-sunken p-3">
                  <dt className="text-xs text-text-muted">{fields[key as Field] ?? key}</dt>
                  <dd className="break-words text-sm">
                    {next === null ? 'Clear value' : String(next)}
                  </dd>
                </div>
              ))}
            </dl>
            <label className="block text-sm" htmlFor={`pin-${edit.id}`}>
              Solo-owner PIN (only for your own edit)
            </label>
            <Input
              id={`pin-${edit.id}`}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={64}
              className="min-h-11"
              value={pins[edit.id] ?? ''}
              onChange={(event) => setPins({ ...pins, [edit.id]: event.target.value })}
            />
            <div className="flex flex-wrap gap-2">
              {(['APPROVE', 'REJECT'] as const).map((decision) => (
                <Button
                  className="min-h-11"
                  key={decision}
                  variant={decision === 'REJECT' ? 'outline' : 'default'}
                  disabled={decide.isPending}
                  onClick={() => {
                    const pin = pins[edit.id];
                    setPins({ ...pins, [edit.id]: '' });
                    decide.mutate({
                      editId: edit.id,
                      decision,
                      ...(pin && decision === 'APPROVE' ? { pin } : {}),
                    });
                  }}
                >
                  {decision === 'APPROVE' ? 'Approve edit' : 'Reject edit'}
                </Button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </SectionCard>
  );
}
