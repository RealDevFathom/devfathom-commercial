import { createHash } from 'node:crypto';
import { buildReceiptPreview, type ReceiptPreviewFacts } from '@/lib/receipts/preview';
import { getRestaurantReceiptLayout } from '@/lib/receipts/restaurant-settings';

import type { MoneyCommandArgs } from '@/lib/restaurant/checkout-routes';
import { buildReceiptForBranch } from '@/lib/restaurant/checkout-routes';
import { appendOrderEvent } from '@/lib/restaurant/outbox';
import {
  PrintDocumentSchema,
  ReceiptPrintSnapshotSchema,
} from '@/lib/restaurant/printing/contract';
import { PrintBridgeService } from '@/lib/restaurant/printing/service';
import type { TerminalContext } from '@/lib/restaurant/terminal-auth';
import { z } from 'zod';

export const receiptPrintBody = z.discriminatedUnion('action', [
  z.object({ billId: z.string().min(1).max(128), action: z.literal('print') }).strict(),
  z
    .object({
      billId: z.string().min(1).max(128),
      action: z.literal('reprint'),
      reason: z.string().trim().min(3).max(200),
      requestId: z.string().uuid(),
    })
    .strict(),
]);

const reference = (billId: string) =>
  `receipt:${createHash('sha256').update(billId).digest('hex')}`;

const jobSelect = {
  id: true,
  status: true,
  printerId: true,
  attemptCount: true,
  lastAttemptAt: true,
  printedAt: true,
  createdAt: true,
} as const;

type SettledReceipt = NonNullable<Awaited<ReturnType<typeof buildReceiptForBranch>>>;

/** Format saved amounts without recomputing, abbreviating, or dropping split/tender facts. */
async function receiptFacts(
  ctx: TerminalContext,
  receipt: SettledReceipt,
  reason?: string
): Promise<ReceiptPreviewFacts> {
  const saved = await ctx.db.restaurantBill.findFirstOrThrow({
    where: { id: receipt.billId, branchId: ctx.device.branchId, status: 'SETTLED' },
    select: {
      discountTotal: true,
      serviceChargeBasis: true,
      serviceChargeRate: true,
      serviceChargeTaxTreatment: true,
      lines: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, taxAmount: true, serviceChargeAmount: true },
      },
      tenders: { orderBy: { createdAt: 'asc' }, select: { id: true, cashReceived: true } },
      taxTransactionSnapshots: {
        where: { branchId: ctx.device.branchId, reversesSnapshotId: null },
        orderBy: { createdAt: 'asc' },
        select: {
          transactionReference: true,
          currency: true,
          buckets: {
            orderBy: { id: 'asc' },
            select: {
              paymentCategory: true,
              priceMode: true,
              rate: true,
              taxableAmount: true,
              taxAmount: true,
              grossAmount: true,
              preDiscountGrossAmount: true,
              beforeTaxDiscountAmount: true,
              afterTaxDiscountAmount: true,
            },
          },
        },
      },
    },
  });
  return {
    businessName: receipt.branchName,
    invoiceNumber: `${receipt.receiptNumber}${reason ? ' - COPY' : ''}`,
    issuedAt: `${receipt.settledAt!.toISOString()} / Business date ${receipt.businessDate}`,
    orderNumber: String(receipt.orderNumber),
    channel: receipt.channel,
    lines: receipt.lines.map((line) => {
      const amounts = saved.lines.find((row) => row.id === line.id)!;
      return `${line.quantity} x ${line.name} @ ${line.unitPrice}\nLine subtotal ${line.lineSubtotal} / Comp ${line.compAmount} / Line total ${line.lineTotal}\nLine tax ${amounts.taxAmount.toFixed(2)} / Line service ${amounts.serviceChargeAmount.toFixed(2)}`;
    }),
    taxLines: [
      `Tax ${receipt.totals.taxTotal}`,
      ...saved.taxTransactionSnapshots.flatMap((tax) => [
        `Tax reference ${tax.transactionReference} / Currency ${tax.currency}`,
        ...tax.buckets.map(
          (bucket) =>
            `${bucket.paymentCategory} / ${bucket.priceMode} / Rate ${bucket.rate.toString()}\nTaxable ${bucket.taxableAmount.toFixed(2)} / Tax ${bucket.taxAmount.toFixed(2)} / Gross ${bucket.grossAmount.toFixed(2)}\nPre-discount gross ${bucket.preDiscountGrossAmount.toFixed(2)} / Before-tax discount ${bucket.beforeTaxDiscountAmount.toFixed(2)} / After-tax discount ${bucket.afterTaxDiscountAmount.toFixed(2)}`
        ),
      ]),
    ],
    totals: [
      `Subtotal ${receipt.totals.subtotal}`,
      `Delivery ${receipt.totals.deliveryFeeTotal}`,
      `Service ${receipt.totals.serviceChargeTotal}`,
      `Comp ${receipt.totals.compTotal}`,
      `Discount ${saved.discountTotal.toFixed(2)}`,
      ...(saved.serviceChargeRate === null
        ? []
        : [
            `Service basis ${saved.serviceChargeBasis.toFixed(2)} / Rate ${saved.serviceChargeRate.toString()} / Tax treatment ${saved.serviceChargeTaxTreatment ?? 'Unspecified'}`,
          ]),
      `Rounding ${receipt.totals.roundingAdjustment}`,
      `TOTAL ${receipt.totals.grandTotal}`,
      `Split ${receipt.splitKind}${receipt.fractionNumerator !== null && receipt.fractionDenominator !== null ? ` ${receipt.fractionNumerator}/${receipt.fractionDenominator}` : ''}`,
      ...(reason ? [`Reprint: ${reason}`] : []),
    ],
    payments: receipt.tenders.length
      ? receipt.tenders.map((t) => {
          const received = saved.tenders.find((row) => row.id === t.id)!.cashReceived;
          return `${t.type} ${t.amount} / Tip ${t.tipAmount}${t.changeGiven === null ? '' : ` / Change ${t.changeGiven}`}${received === null ? '' : ` / Cash received ${received.toFixed(2)}`}`;
        })
      : ['No tenders recorded.'],
  };
}

async function browserPreview(ctx: TerminalContext, receipt: SettledReceipt, document?: unknown) {
  const stored = document ? PrintDocumentSchema.parse(document).receiptSnapshot : undefined;
  if (stored)
    return {
      text: buildReceiptPreview(stored.layout, stored.facts),
      paperWidth: stored.layout.paperWidth,
      source: 'queued' as const,
    };
  const { layout } = await getRestaurantReceiptLayout(
    ctx.db,
    ctx.organizationId,
    ctx.device.branchId
  );
  const facts = await receiptFacts(ctx, receipt);
  const snapshot = ReceiptPrintSnapshotSchema.safeParse({ layout, facts });
  return {
    text: snapshot.success ? buildReceiptPreview(snapshot.data.layout, snapshot.data.facts) : null,
    paperWidth: layout.paperWidth,
    source: 'saved' as const,
    // Lossless inert text fallback only. Shared Unicode layout parity belongs to WHA-1354.
    plainText: snapshot.success
      ? undefined
      : [
          facts.businessName,
          `Invoice: ${facts.invoiceNumber}`,
          facts.issuedAt,
          `Order: ${facts.orderNumber} / Channel: ${facts.channel}`,
          ...facts.lines,
          ...facts.taxLines,
          ...facts.totals,
          ...facts.payments,
        ].join('\n'),
  };
}

export async function receiptPrintState(ctx: TerminalContext, receipt: SettledReceipt) {
  const [route, latestJob] = await Promise.all([
    ctx.db.restaurantPrintRoute.findFirst({
      where: {
        branchId: ctx.device.branchId,
        documentType: 'RECEIPT',
        stationId: null,
        enabled: true,
      },
      orderBy: { createdAt: 'asc' },
      select: { printerId: true },
    }),
    ctx.db.restaurantPrintJob.findFirst({
      where: {
        branchId: ctx.device.branchId,
        documentType: 'RECEIPT',
        document: { path: ['reference'], equals: reference(receipt.billId) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { ...jobSelect, document: true },
    }),
  ]);
  return {
    branchId: ctx.device.branchId,
    registerId: ctx.device.id,
    registerName: ctx.device.name,
    printerId: route?.printerId ?? null,
    latestJob: latestJob ? { ...latestJob, document: undefined } : null,
    preview: await browserPreview(ctx, receipt, latestJob?.document),
  };
}

/** Runs inside moneyMutationRoute's tenant transaction; no caller-supplied money or routing. */
export async function dispatchReceipt({
  ctx,
  data,
  actor,
}: MoneyCommandArgs<typeof receiptPrintBody>) {
  if (ctx.device.kind !== 'POS')
    return Response.json({ error: 'A POS register is required.' }, { status: 403 });
  const receipt = await buildReceiptForBranch(ctx.db, data.billId, ctx.device.branchId);
  if (!receipt || receipt.receiptNumber === null || !receipt.settledAt) {
    return Response.json({ error: 'No issued settled receipt with that id.' }, { status: 404 });
  }
  const documentReference = reference(data.billId);
  await ctx.db.$executeRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    `${ctx.organizationId}:${ctx.device.branchId}:${documentReference}`
  );
  const state = await receiptPrintState(ctx, receipt);
  const idempotencyKey =
    data.action === 'print'
      ? `${documentReference}:original`
      : `${documentReference}:reprint:${data.requestId}`;
  const prior = await ctx.db.restaurantPrintJob.findUnique({
    where: {
      organizationId_branchId_idempotencyKey: {
        organizationId: ctx.organizationId,
        branchId: ctx.device.branchId,
        idempotencyKey,
      },
    },
    select: { ...jobSelect, document: true },
  });
  // Return the actual persisted state even if routes were removed after submission.
  if (prior) {
    if (data.action === 'reprint') {
      const priorDocument = PrintDocumentSchema.safeParse(prior.document);
      if (
        !priorDocument.success ||
        (priorDocument.data.receiptSnapshot
          ? priorDocument.data.footer !== `Receipt copy\nReprint: ${data.reason}`
          : !priorDocument.data.footer?.endsWith(`\nReprint: ${data.reason}`))
      ) {
        return Response.json(
          { error: 'This reprint request was already used with a different reason.' },
          { status: 409 }
        );
      }
    }
    const job = {
      id: prior.id,
      status: prior.status,
      printerId: prior.printerId,
      attemptCount: prior.attemptCount,
      lastAttemptAt: prior.lastAttemptAt,
      printedAt: prior.printedAt,
      createdAt: prior.createdAt,
    };
    return {
      ...state,
      latestJob: job,
      preview: await browserPreview(ctx, receipt, prior.document),
      replayed: true,
    };
  }
  if (data.action === 'reprint' && (!state.latestJob || state.latestJob.status !== 'PRINTED')) {
    return Response.json(
      {
        error:
          'Reprint requires a bridge-acknowledged receipt. Check the existing job before requesting another copy.',
      },
      { status: 409 }
    );
  }
  if (!state.printerId) return { ...state, outcome: 'NO_PRINTER' as const, replayed: false };

  const { layout } = await getRestaurantReceiptLayout(
    ctx.db,
    ctx.organizationId,
    ctx.device.branchId
  );
  // Shared snapshot is authoritative; legacy envelope fields are compatibility metadata only.
  const document = PrintDocumentSchema.safeParse({
    type: 'RECEIPT',
    reference: documentReference,
    title: `Receipt ${receipt.receiptNumber}${data.action === 'reprint' ? ' - COPY' : ''}`,
    createdAt: receipt.settledAt.toISOString(),
    lines: [{ quantity: 1, label: 'Settled receipt; see captured receipt snapshot.' }],
    footer: data.action === 'reprint' ? `Receipt copy\nReprint: ${data.reason}` : undefined,
    receiptSnapshot: {
      layout,
      facts: await receiptFacts(ctx, receipt, data.action === 'reprint' ? data.reason : undefined),
    },
  });
  if (
    !document.success ||
    [
      document.data.title,
      ...document.data.lines.map((line) => line.label),
      document.data.footer ?? '',
    ].some((value) => /[^\x20-\x7e\n]/.test(value))
  ) {
    return Response.json(
      {
        error:
          'This receipt exceeds the current printer layout limits. Use the browser receipt or ask an administrator to configure a supported layout.',
      },
      { status: 422 }
    );
  }
  const result = await new PrintBridgeService(ctx.db).enqueue(
    ctx.organizationId,
    {
      branchId: ctx.device.branchId,
      routes: [
        { documentType: 'RECEIPT', stationId: null, printerId: state.printerId, enabled: true },
      ],
    },
    { branchId: ctx.device.branchId, stationId: null, idempotencyKey, document: document.data }
  );
  if (result.status !== 'NO_PRINTER' && !result.replayed) {
    await appendOrderEvent(ctx.db, {
      orderId: receipt.orderId,
      eventType:
        data.action === 'reprint' ? 'receipt.reprint_requested' : 'receipt.print_requested',
      actorStaffProfileId: actor.staffProfileId,
      actorDeviceId: ctx.device.id,
      payload: {
        billId: data.billId,
        printerId: state.printerId,
        idempotencyKey,
        reason: data.action === 'reprint' ? data.reason : null,
      },
    });
  }
  return {
    ...(await receiptPrintState(ctx, receipt)),
    outcome: result.status,
    replayed: result.replayed,
  };
}
