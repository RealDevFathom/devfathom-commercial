'use client';

import { useCallback, useEffect, useState } from 'react';

import { createCounterIndexedDbDriver } from '@/lib/pharmacy/counter-offline-runtime';
import {
  readReconcileIndex,
  readReconcileRecord,
  reconcileSalesOf,
  settleReconciledSale,
  type ReconcileSale,
} from '@/lib/pharmacy/counter-reconcile';
import type { TerminalStorageDriver } from '@/lib/retail-terminal/local-store';

export type CounterReconcileView = {
  /** Unsent sales kept from counters this computer no longer is, for this branch. */
  sales: ReconcileSale[];
  /** False while reading, or when this browser cannot read its storage. */
  loaded: boolean;
  /** A manager recorded this sale (or the server holds it): it leaves this computer. */
  settle(sale: ReconcileSale): Promise<void>;
  reload(): void;
};

/**
 * DEV-957 phase 2 (review B2): the read-only "Sales to reconcile" of this computer, for one
 * branch, online or offline. Reads only; the one change it makes is removing a sale a
 * manager has recorded on the server.
 */
export function useCounterReconcile(input: {
  organizationId: string;
  branchId: string;
  /** Changes when a revoke on this computer may have added sales. */
  refreshKey?: unknown;
  /** Injected in tests. */
  driverFactory?: () => TerminalStorageDriver;
}): CounterReconcileView {
  const { organizationId, branchId, refreshKey, driverFactory } = input;
  const [sales, setSales] = useState<ReconcileSale[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    let driver: TerminalStorageDriver | null = null;
    void (async () => {
      try {
        driver = (driverFactory ?? createCounterIndexedDbDriver)();
        const entries = (await readReconcileIndex(driver)).filter(
          (entry) => entry.organizationId === organizationId && entry.branchId === branchId
        );
        const rows: ReconcileSale[] = [];
        for (const entry of entries) {
          const record = await readReconcileRecord(driver, entry.recordKey);
          if (record) rows.push(...reconcileSalesOf(record, entry.recordKey));
        }
        if (!cancelled) {
          setSales(rows.sort((a, b) => a.soldAt.localeCompare(b.soldAt)));
          setLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setSales([]);
          setLoaded(false);
        }
      } finally {
        driver?.close();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, branchId, refreshKey, attempt, driverFactory]);

  const settle = useCallback(
    async (sale: ReconcileSale) => {
      const driver = (driverFactory ?? createCounterIndexedDbDriver)();
      try {
        await settleReconciledSale(driver, sale.recordKey, sale.commandId);
      } finally {
        driver.close();
      }
      reload();
    },
    [driverFactory, reload]
  );

  return { sales, loaded, settle, reload };
}
