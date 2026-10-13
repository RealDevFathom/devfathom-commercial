'use client';
import { Button } from '@/components/ui/button';
import { stagedReferencesCsv, type StagedReference } from '@/lib/pharmacy/migration/staged-review';

export function StagedMedicineExport({ rows }: { rows: StagedReference[] }) {
  return (
    <Button
      variant="outline"
      className="min-h-11"
      disabled={rows.length === 0}
      onClick={() => {
        const url = URL.createObjectURL(
          new Blob([stagedReferencesCsv(rows)], { type: 'text/csv;charset=utf-8' })
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'staged-medicine-references.csv';
        anchor.click();
        URL.revokeObjectURL(url);
      }}
    >
      Export this page’s references
    </Button>
  );
}
