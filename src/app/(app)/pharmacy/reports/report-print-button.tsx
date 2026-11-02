'use client';

import { Button } from '@/components/ui/button';

export function ReportPrintButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="touch"
      className="print:hidden"
      onClick={() => window.print()}
    >
      Print / PDF
    </Button>
  );
}
