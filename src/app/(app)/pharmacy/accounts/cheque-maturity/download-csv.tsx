'use client';

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function DownloadCsv({ csv, fileName }: { csv: string; fileName: string }) {
  function download() {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Button type="button" variant="secondary" onClick={download}>
      <Download aria-hidden />
      Download CSV
    </Button>
  );
}
