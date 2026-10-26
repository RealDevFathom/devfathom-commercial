import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  buildReceiptForBranch,
  moneyReadRoute,
  moneyMutationRoute,
} from '@/lib/restaurant/checkout-routes';
import { dispatchReceipt, receiptPrintBody, receiptPrintState } from './receipt-dispatch';

const query = z.object({ billId: z.string().min(1) });

/**
 * GET /api/restaurant/checkout/receipt?billId=…
 *
 * The settled-bill receipt payload and durable print status for the register (C10/C12): the
 * receipt number seam, the bill's lines + totals, and the tenders with change/tip. Never
 * PAN/CVV/track data (C6). Returned only for a SETTLED bill in the device's branch; any
 * other id is a 404. Gated on `payments:collect`.
 */
export const GET = moneyReadRoute({
  capability: 'payments:collect',
  run: async (ctx, request) => {
    if (ctx.device.kind !== 'POS')
      return NextResponse.json({ error: 'A POS register is required.' }, { status: 403 });
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      return NextResponse.json({ error: 'A non-empty billId query is required.' }, { status: 400 });
    }
    const receipt = await buildReceiptForBranch(ctx.db, parsed.data.billId, ctx.device.branchId);
    if (!receipt || receipt.receiptNumber === null || !receipt.settledAt) {
      return NextResponse.json({ error: 'No settled bill with that id.' }, { status: 404 });
    }
    return NextResponse.json(
      { ...receipt, printing: await receiptPrintState(ctx, receipt) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  },
});

export const POST = moneyMutationRoute({
  capability: 'payments:collect',
  schema: receiptPrintBody,
  obscureBillId: (data) => data.billId,
  run: dispatchReceipt,
});
