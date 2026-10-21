import { mergeTables } from '@/lib/restaurant/orders';
import { mergeTablesBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/merge-tables
 *
 * Merge additional tables under one order (each becomes an active MERGE link; L2
 * `mergeTables`). Combining two open orders into one is deferred (BUILD-ASSUMPTIONS).
 */
export const POST = terminalCommandRoute(mergeTablesBody, ({ ctx, data, actor }) =>
  mergeTables(ctx.db, { orderId: data.orderId, tableIds: data.tableIds, actor })
);
