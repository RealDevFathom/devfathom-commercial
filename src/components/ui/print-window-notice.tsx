'use client';

import { useSyncExternalStore } from 'react';
import { Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  focusPrintWindows,
  getOpenPrintWindowCount,
  subscribePrintWindows,
} from '@/lib/browser-print/print-window';
import { cn } from '@/lib/utils';

const noPrintWindows = () => 0;

/**
 * DEV-973: one line while a print window is open, so a window that went behind
 * this page is never lost. The page itself stays usable the whole time.
 */
export function PrintWindowNotice({ className }: { className?: string }) {
  const open = useSyncExternalStore(subscribePrintWindows, getOpenPrintWindowCount, noPrintWindows);
  if (open === 0) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border-subtle bg-surface-sunken px-4 py-1.5 text-xs text-text-body print:hidden',
        className
      )}
    >
      <span className="flex items-center gap-2">
        <Printer className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        Print window is open. Finish or cancel it there.
      </span>
      <Button type="button" variant="outline" size="sm" onClick={focusPrintWindows}>
        Show print window
      </Button>
    </div>
  );
}
