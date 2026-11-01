'use client';

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function AccountActivityExportButton({ csv, filename }: { csv: string; filename: string }) {
  function download() {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Defer revocation so browsers that start the download asynchronously do not cancel it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Button type="button" size="lg" onClick={download}>
      <Download data-icon="inline-start" />
      Export evidence CSV
    </Button>
  );
}
