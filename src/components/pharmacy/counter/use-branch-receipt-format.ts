'use client';

import { useCallback, useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { CounterReceiptFormat } from '@/lib/pharmacy/counter-browser-print';
import { counterFormatForSettings } from '@/lib/pharmacy/printer-settings';

/**
 * DEV-742: the counter's receipt paper. It starts on the branch's saved paper (Settings →
 * Printers) and the operator can still switch it for this session; switching branch goes
 * back to that branch's saved paper. If the saved settings cannot be read, it falls back to
 * thermal 80 mm, the counter's previous fixed default, rather than blocking the sale.
 */
export function useBranchReceiptFormat(
  branchId: string
): readonly [CounterReceiptFormat, (format: CounterReceiptFormat) => void] {
  const saved = trpc.pharmacySales.counterReceiptFormat.useQuery(
    { branchId },
    // An audited read: settings change rarely, so don't add an audit row per focus/minute.
    {
      enabled: Boolean(branchId),
      staleTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: false,
    }
  );
  const [choice, setChoice] = useState<{ branchId: string; format: CounterReceiptFormat } | null>(
    null
  );
  const savedFormat: CounterReceiptFormat = saved.data
    ? counterFormatForSettings(saved.data)
    : 'THERMAL';
  const format = choice && choice.branchId === branchId ? choice.format : savedFormat;
  const choose = useCallback(
    (next: CounterReceiptFormat) => setChoice({ branchId, format: next }),
    [branchId]
  );
  return [format, choose] as const;
}
