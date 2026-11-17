'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

/** Print only already-authorized content; wait for the separately streamed work pack. */
export function ReportPrintButton() {
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const report = document.querySelector('[data-report-print]');
    if (!report) return;
    const update = () => setLoading(!!report.querySelector('[aria-busy="true"]'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(report, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-busy'],
    });
    return () => observer.disconnect();
  }, []);
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      className="print:hidden"
      disabled={loading}
      onClick={() => window.print()}
    >
      {loading ? 'Preparing report for print…' : 'Print / Save as PDF'}
    </Button>
  );
}
