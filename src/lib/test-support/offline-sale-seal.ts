/**
 * DEV-957 phase 2 (hardening 4), tests only: seal replay bodies the way a counter does at
 * the moment of sale, keeping each counter's chain. A body that already carries a seal is
 * sent as it is (a test about a broken chain builds its own).
 */
import { sealOfflineSale } from '@/lib/pharmacy/offline-sale-seal-node';
import type { OfflineSaleSeal, SealableSale } from '@/lib/pharmacy/offline-sale-seal';

type Scope = { organizationId: string; branchId: string };

/** Line totals that add up to the bill: the whole amount on the first line. */
export function wholeAmountOnFirstLine(sale: Pick<SealableSale, 'lines' | 'amountMinor'>): number[] {
  return sale.lines.map((_, index) => (index === 0 ? sale.amountMinor : 0));
}

/**
 * One chain per counter: the seal names the hash of the sale with the sequence just
 * below, when this chain has sealed it.
 */
export function offlineSaleChain(scope: Scope, deviceId: string, deviceSecret: string) {
  const hashes = new Map<number, string>();
  return {
    seal<T extends SealableSale & { seal?: OfflineSaleSeal }>(
      sale: T,
      options: { previousHash?: string | null; lineTotalsMinor?: number[] } = {}
    ): T & { seal: OfflineSaleSeal } {
      if (sale.seal) return sale as T & { seal: OfflineSaleSeal };
      const sealed = sealOfflineSale(
        { ...scope, deviceId },
        sale,
        {
          previousHash:
            options.previousHash !== undefined
              ? options.previousHash
              : (hashes.get(sale.sequence - 1) ?? null),
          lineTotalsMinor: options.lineTotalsMinor ?? wholeAmountOnFirstLine(sale),
        },
        deviceSecret
      );
      hashes.set(sale.sequence, sealed.hash);
      return { ...sale, seal: sealed.seal };
    },
    hashOf(sequence: number): string | null {
      return hashes.get(sequence) ?? null;
    },
  };
}
