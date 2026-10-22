/** The small stock boundary shared with the independently-developed reorder feature. */
export type StockBatchSnapshot = {
  id: string;
  orgId: string;
  quantity: number;
  unitsSoldPerDay: number;
  expiresAt: Date;
  status: 'AVAILABLE' | 'RECALLED' | 'QUARANTINED';
  costMinor: number;
  priceMinor: number;
  mrpMinor: number;
};

/** Implementations must apply `orgId` in the database predicate (and remain RLS-compatible). */
export interface StockBatchReadPort {
  listStockBatches(orgId: string): Promise<readonly StockBatchSnapshot[]>;
}

export const emptyStockBatchReadPort: StockBatchReadPort = {
  async listStockBatches() {
    return [];
  },
};
