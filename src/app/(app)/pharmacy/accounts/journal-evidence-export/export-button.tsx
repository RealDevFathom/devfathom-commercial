'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  journalEvidenceCsv,
  type JournalEvidencePage,
} from '@/lib/pharmacy/accounts/journal-evidence-export';

export function JournalEvidenceExportButton({ evidence }: { evidence: JournalEvidencePage }) {
  const [message, setMessage] = useState('');

  function download() {
    let url: string | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([journalEvidenceCsv(evidence)], { type: 'text/csv;charset=utf-8' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `pharmacy-journal-evidence-page-${evidence.page}.csv`;
      link.click();
      setMessage('Page-bounded journal evidence CSV downloaded.');
    } catch {
      setMessage('CSV download could not start. No evidence was exported.');
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button className="min-h-11" type="button" onClick={download}>
        Export this page (CSV)
      </Button>
      <p aria-live="polite" className="text-sm text-text-muted">
        {message}
      </p>
    </div>
  );
}
