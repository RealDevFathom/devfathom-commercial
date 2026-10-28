'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { browserUuid } from '@/lib/browser-uuid';
import { parseSimpleMedicineStrength } from '@/lib/pharmacy/medicine';
import { trpc } from '@/lib/trpc';

const fields = [
  ['productName', 'Product name', 300],
  ['alias', 'Generic ingredient name', 300],
  ['strength', 'Strength (for example, 500 mg)', 100],
  ['dosageForm', 'Dosage form', 100],
  ['pack', 'Presentation (for example, 10 tablets)', 300],
  ['drapRegistrationNumber', 'DRAP registration number', 100],
  ['manufacturer', 'Manufacturer', 300],
] as const;

export function CreateMedicine() {
  const utils = trpc.useUtils();
  const [values, setValues] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState('');
  const [created, setCreated] = useState(false);
  const create = trpc.pharmacyMedicine.createMedicine.useMutation({
    onSuccess: async () => {
      setCreated(true);
      await utils.pharmacyMedicine.referenceCandidates.invalidate();
    },
  });
  const denied = ['FORBIDDEN', 'UNAUTHORIZED'].includes(create.error?.data?.code ?? '');
  return (
    <SectionCard title="Create medicine" titleLevel={2}>
      <p className="mb-5 text-sm text-text-muted">
        Adding your first medicine? No import is needed. Enter the facts from its packaging and
        registration record, create a draft, then accept and publish its assertions below. Finally,
        define an effective pack for receiving. Publication enables catalogue selection; selling
        still requires received stock and the usual sale checks.
      </p>
      {created ? (
        <div role="status" className="space-y-3 text-sm text-text-body">
          <p>
            Draft created. Review its facts under Review and publication below, accept them, then
            publish and add a pack.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setCreated(false);
              setValues({});
              create.reset();
            }}
          >
            Add another medicine
          </Button>
        </div>
      ) : (
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (create.isPending || denied) return;
            if (!parseSimpleMedicineStrength(values.strength ?? '')) {
              setValidation(
                'Enter one positive strength, such as 500 mg. Compound strengths require structured review.'
              );
              return;
            }
            setValidation('');
            const batchId = browserUuid();
            const retrievedAt = new Date();
            create.mutate({
              productName: values.productName.trim(),
              productFamily: 'PHARMACEUTICAL',
              saleable: false,
              provenance: fields.map(([field]) => ({
                field,
                source: values.source.trim(),
                sourceType: 'USER',
                retrievedAt,
                status: 'UNREVIEWED',
                assertedValue: {
                  value: values[field].trim(),
                  connectorId: 'manual-entry',
                  sourceLabel: values.source.trim(),
                  batchId,
                  rowSourceKey: 'manual-entry',
                  rights: {
                    acquisition: 'Operator supplied product evidence',
                    cache: 'Workspace catalogue',
                    redistribution: 'Workspace only',
                    deletion: 'Retain review audit',
                  },
                  blockingIssues: [],
                },
              })),
            });
          }}
        >
          <fieldset
            disabled={create.isPending || denied}
            className="grid min-w-0 gap-4 md:grid-cols-2"
          >
            <legend className="sr-only">Medicine facts</legend>
            {fields.map(([field, label, maxLength]) => (
              <label key={field} className="space-y-2 text-sm text-text-body">
                <span>{label}</span>
                <Input
                  className="min-h-11"
                  required
                  maxLength={maxLength}
                  value={values[field] ?? ''}
                  aria-invalid={field === 'strength' && Boolean(validation)}
                  aria-describedby={
                    field === 'strength' && validation ? 'medicine-strength-error' : undefined
                  }
                  onChange={(event) => {
                    setValues({ ...values, [field]: event.target.value });
                    if (field === 'strength') setValidation('');
                  }}
                />
              </label>
            ))}
            <label className="space-y-2 text-sm text-text-body">
              <span>Evidence source (pack label or registration record)</span>
              <Input
                className="min-h-11"
                required
                maxLength={500}
                value={values.source ?? ''}
                onChange={(event) => setValues({ ...values, source: event.target.value })}
              />
            </label>
          </fieldset>
          {validation ? (
            <p id="medicine-strength-error" role="alert" className="text-sm text-destructive">
              {validation}
            </p>
          ) : null}
          {create.error ? (
            <p role="alert" className="text-sm text-destructive">
              {denied
                ? 'Medicine creation permission required. Ask your workspace administrator to check access.'
                : `Could not create the draft: ${create.error.message}`}{' '}
              Your entries are preserved.
            </p>
          ) : null}
          <Button type="submit" className="min-h-11" disabled={create.isPending || denied}>
            {create.isPending ? 'Creating medicine…' : 'Create medicine'}
          </Button>
        </form>
      )}
    </SectionCard>
  );
}
