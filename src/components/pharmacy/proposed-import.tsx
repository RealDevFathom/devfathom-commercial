'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { trpc } from '@/lib/trpc';
import { StagedMedicineCreation } from './staged-medicine-creation';

export function ProposedImport({ editId }: { editId: string }) {
  const [page, setPage] = useState(1);
  const proposal = trpc.pharmacyMedicine.proposedImport.useQuery(
    { editId, page },
    { retry: false }
  );
  if (proposal.isPending) return <p role="status">Loading proposed medicines…</p>;
  if (proposal.error)
    return (
      <p role="alert" className="text-destructive">
        {proposal.error.message === 'You do not have permission for this action.'
          ? 'Only a catalogue reviewer can inspect the proposed medicines. Ask the pharmacy owner to assign a reviewer.'
          : proposal.error.message}
      </p>
    );
  return (
    <section aria-label="Proposed medicines" className="space-y-3 text-sm">
      {proposal.data.rows.length === 0 && <p>No medicine rows on this page.</p>}
      {proposal.data.rows.map((row) => (
        <div key={row.rowNumber} className="min-w-0 border-b border-border-subtle py-2">
          <p className="break-words font-semibold">
            {row.productName ?? 'Unnamed row — no medicine will be created'}
          </p>
          <p className="text-text-muted">Row {row.rowNumber}</p>
          {row.productName && (
            <details>
              <summary className="min-h-11 cursor-pointer content-center rounded-control focus-visible:outline-2 focus-visible:outline-ring">
                Medicine details
              </summary>
              <dl className="grid gap-2 sm:grid-cols-2">
                {Object.entries({
                  Presentation: row.presentation,
                  'Units per pack': row.unitsPerPack,
                  'Pack MRP': row.mrpMinor === null ? null : 'Rs ' + formatMinor(row.mrpMinor),
                  'Generic name': row.genericName,
                  Barcode: row.barcode,
                  'Controlled from the file': row.controlled ? 'Yes' : 'No',
                }).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-text-muted">{label}</dt>
                    <dd className="break-words">{value ?? 'Not recorded'}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </div>
      ))}
      <nav aria-label="Proposed medicine pages" className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="touch"
          disabled={page === 1}
          onClick={() => setPage(page - 1)}
        >
          Previous
        </Button>
        <span>Page {page}</span>
        <Button
          type="button"
          variant="outline"
          size="touch"
          disabled={!proposal.data.hasMore}
          onClick={() => setPage(page + 1)}
        >
          Next
        </Button>
      </nav>
    </section>
  );
}

export function ApprovedImportCreation({
  batchId,
  fileName,
}: {
  batchId: string;
  fileName: string;
}) {
  const state = trpc.pharmacyMedicine.stagedMedicineCreation.useQuery(
    { batchId },
    { retry: false }
  );
  if (state.isPending) return <p role="status">Loading the approved import…</p>;
  if (state.error)
    return (
      <p role="alert" className="text-destructive">
        {state.error.message}
      </p>
    );
  return (
    <div className="space-y-2">
      <p className="break-words text-sm font-semibold">Approved file · {fileName}</p>
      <StagedMedicineCreation batchId={batchId} initial={state.data} />
    </div>
  );
}
