'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Field, WorkspaceState, fieldClass } from './field';
import { SubstitutionForm, type SubstitutionValue } from './substitution-form';

export function SubstitutionConsole() {
  const workspace = trpc.pharmacyDispensing.substitutionWorkspace.useQuery();
  const mutation = trpc.pharmacyDispensing.recordSubstitution.useMutation();
  const [itemId, setItemId] = useState('');
  const [notice, setNotice] = useState('');
  const item = workspace.data?.lines.find((entry) => entry.id === itemId);
  async function submit(value: SubstitutionValue) {
    if (!item) return;
    await mutation.mutateAsync({
      prescriptionLineId: item.prescriptionLineId,
      saleLineId: item.saleLineId,
      prescribedPresentationId: item.line.presentationId,
      ...value,
    });
    setNotice('Substitution recorded.');
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Substitution"
        description="When you give a different strength, form or brand than prescribed, record what changed and what you told the patient."
      />
      {workspace.isLoading ? (
        <WorkspaceState title="Loading eligible lines">
          Retrieving pharmacist-review lines.
        </WorkspaceState>
      ) : null}
      {workspace.error ? (
        <WorkspaceState title="Substitution workspace could not be loaded" tone="danger">
          {workspace.error.message}
        </WorkspaceState>
      ) : null}
      {workspace.data ? (
        <SectionCard title="Record substitution" titleLevel={2} className="max-w-3xl">
          <div className="mb-5">
            <Field label="Prescription line">
              <select
                className={fieldClass}
                value={itemId}
                onChange={(e) => {
                  setItemId(e.target.value);
                  setNotice('');
                }}
              >
                <option value="">Select patient and medicine</option>
                {workspace.data.lines.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.line.prescription.patient.displayName} ·{' '}
                    {entry.line.medicine.productName} · {entry.line.presentation.presentation}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {item ? (
            <SubstitutionForm
              prescribed={{
                id: item.line.presentation.id,
                label: item.line.presentation.presentation,
              }}
              choices={item.line.medicine.presentations.map((presentation) => ({
                id: presentation.id,
                label: presentation.presentation,
              }))}
              pending={mutation.isPending}
              onSubmit={submit}
            />
          ) : (
            <WorkspaceState title="Choose a prescription line">
              Pick a prescription line above to record what you are giving instead. Every
              substitution must be recorded here.
            </WorkspaceState>
          )}
          {mutation.error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {mutation.error.message}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="mt-3 text-sm text-success">
              {notice}
            </p>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
