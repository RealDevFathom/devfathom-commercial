import type { ReactNode } from 'react';
import { PHARMACY_COPY } from '@/lib/pharmacy/plain-language';

/** Native disclosure keeps report limits available to keyboard and touch users. */
export function ReportDetails({ children }: { children: ReactNode }) {
  return (
    <details className="my-3 text-sm text-text-muted">
      <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring">
        {PHARMACY_COPY.details}
      </summary>
      <div className="space-y-3">{children}</div>
    </details>
  );
}
