'use client';

import { useSyncExternalStore } from 'react';
import { Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  focusPrintWindows,
  getConfirmedPrintWindowCount,
  subscribePrintWindows,
} from '@/lib/browser-print/print-window';
import { cn } from '@/lib/utils';

const noPrintWindows = () => 0;

/**
 * DEV-973: one line while a print window is open, so a window that went behind
 * this page is never lost. The page itself stays usable the whole time. The
 * live region is always mounted and only its text changes, so screen readers
 * announce the line when it appears.
 */
export function PrintWindowNotice({ className }: { className?: string }) {
  const open = useSyncExternalStore(
    subscribePrintWindows,
    getConfirmedPrintWindowCount,
    noPrintWindows
  );
  return (
    <div role="status" className="print:hidden">
      {open > 0 ? (
        <div
          className={cn(
            'flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border-subtle bg-surface-sunken px-4 py-1.5 text-xs text-text-body',
            className
          )}
        >
          <span className="flex items-center gap-2">
            <Printer className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            Finish or cancel printing in the print window. It may be behind this window.
          </span>
          <Button type="button" variant="outline" size="sm" onClick={focusPrintWindows}>
            Show print window
          </Button>
        </div>
      ) : null}
    </div>
  );
}
