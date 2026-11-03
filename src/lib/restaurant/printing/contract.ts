import { z } from 'zod';
import { ReceiptLayoutSchema, receiptTextSchema } from '@/lib/receipts/configuration';
import { ReceiptPreviewFactsSchema } from '@/lib/receipts/preview';

export const ReceiptPrintSnapshotSchema = z
  .object({ layout: ReceiptLayoutSchema, facts: ReceiptPreviewFactsSchema })
  .strict();
export type ReceiptPrintSnapshot = z.infer<typeof ReceiptPrintSnapshotSchema>;

export const PrintDocumentTypeSchema = z.enum(['KITCHEN_TICKET', 'BAR_TICKET', 'RECEIPT']);
export type PrintDocumentType = z.infer<typeof PrintDocumentTypeSchema>;

export const PrintLineSchema = z
  .object({ quantity: z.number().positive().max(999), label: receiptTextSchema(160).trim().min(1) })
  .strict();

const PrintDocumentFieldsSchema = z
  .object({
    type: PrintDocumentTypeSchema,
    reference: receiptTextSchema(80).trim().min(1),
    title: receiptTextSchema(80).trim().min(1),
    createdAt: z.string().datetime(),
    lines: z.array(PrintLineSchema).min(1).max(200),
    footer: receiptTextSchema(500).trim().optional(),
    receiptSnapshot: ReceiptPrintSnapshotSchema.optional(),
  })
  .strict();

export const PrintDocumentSchema = PrintDocumentFieldsSchema.refine(
  (document) => !document.receiptSnapshot || document.type === 'RECEIPT',
  {
    message: 'Receipt snapshots require a RECEIPT document.',
    path: ['receiptSnapshot'],
  }
);
export type PrintDocument = z.infer<typeof PrintDocumentSchema>;

/** Server-owned metadata on persisted kitchen/bar documents, never an inbound field. */
export const TicketPrintSnapshotSchema = z
  .object({
    paperWidthMm: z.union([z.literal(58), z.literal(80)]),
  })
  .strict();
export type TicketPrintSnapshot = z.infer<typeof TicketPrintSnapshotSchema>;
export const StoredPrintDocumentSchema = PrintDocumentFieldsSchema.extend({
  ticketPrintSnapshot: TicketPrintSnapshotSchema.optional(),
})
  .refine((document) => !document.receiptSnapshot || document.type === 'RECEIPT', {
    message: 'Receipt snapshots require a RECEIPT document.',
    path: ['receiptSnapshot'],
  })
  .refine((document) => !document.ticketPrintSnapshot || document.type !== 'RECEIPT', {
    message: 'Printer width snapshots require a kitchen or bar ticket.',
    path: ['ticketPrintSnapshot'],
  });
export type StoredPrintDocument = z.infer<typeof StoredPrintDocumentSchema>;

export class RawPrintValidationError extends Error {
  readonly fallback: 'BROWSER_OS' | null;

  constructor(readonly code: 'INVALID_PRINT_DOCUMENT' | 'UNSUPPORTED_PRINT_TEXT') {
    super(
      code === 'UNSUPPORTED_PRINT_TEXT'
        ? 'Unsupported printer text. Use a browser/OS-rendered receipt.'
        : 'Invalid print document. Correct the receipt data before printing.'
    );
    this.name = 'RawPrintValidationError';
    this.fallback = code === 'UNSUPPORTED_PRINT_TEXT' ? 'BROWSER_OS' : null;
  }
}

/** Call before queue acceptance, including direct service calls. No I/O or payload in errors. */
export function validateRawPrintDocument(input: unknown): PrintDocument {
  const parsed = PrintDocumentSchema.safeParse(input);
  if (!parsed.success) throw new RawPrintValidationError('INVALID_PRINT_DOCUMENT');
  return validateAsciiPrintText(parsed.data);
}

/** Stored readers accept historical documents and validated server-owned ticket snapshots. */
export function validateRawStoredPrintDocument(input: unknown): StoredPrintDocument {
  const parsed = StoredPrintDocumentSchema.safeParse(input);
  if (!parsed.success) throw new RawPrintValidationError('INVALID_PRINT_DOCUMENT');
  return validateAsciiPrintText(parsed.data);
}

function validateAsciiPrintText<T extends PrintDocument>(document: T): T {
  const values = [
    document.title,
    document.reference,
    document.footer ?? '',
    ...document.lines.map((line) => line.label),
  ];
  if (document.receiptSnapshot) {
    const { layout, facts } = document.receiptSnapshot;
    values.push(
      layout.businessText,
      layout.headerText,
      layout.footerText,
      facts.businessName,
      facts.invoiceNumber,
      facts.invoiceLabel ?? '',
      facts.issuedAt,
      facts.orderNumber ?? '',
      facts.channel ?? '',
      ...facts.lines,
      ...facts.taxLines,
      ...facts.totals,
      ...facts.payments
    );
  }
  if (values.some((value) => !/^[\x20-\x7e\n]*$/.test(value)))
    throw new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT');
  return document;
}

export const PrintRouteSchema = z
  .object({
    documentType: PrintDocumentTypeSchema,
    stationId: z.string().trim().min(1).max(128).nullable(),
    printerId: z.string().trim().min(1).max(128),
    registeredPrinterId: z.string().trim().min(1).max(128).nullable().optional(),
    enabled: z.boolean(),
  })
  .strict();
export type PrintRoute = z.infer<typeof PrintRouteSchema>;

export const PrintRoutingConfigSchema = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    routes: z.array(PrintRouteSchema).max(100),
  })
  .strict();
export type PrintRoutingConfig = z.infer<typeof PrintRoutingConfigSchema>;

export const PrintJobSchema = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    stationId: z.string().trim().min(1).max(128).nullable(),
    idempotencyKey: z.string().trim().min(8).max(160),
    document: PrintDocumentSchema,
  })
  .strict();
export type PrintJob = z.infer<typeof PrintJobSchema>;

export const PrintRoutingRequestSchema = PrintRoutingConfigSchema.extend({
  expectedConfig: PrintRoutingConfigSchema.optional(),
}).refine(
  (request) => !request.expectedConfig || request.expectedConfig.branchId === request.branchId,
  {
    message: 'Expected routing must belong to the same branch.',
    path: ['expectedConfig'],
  }
);

export const ExpectedPrintDestinationSchema = z
  .object({
    printerId: z.string().trim().min(1).max(128),
    registeredPrinterId: z.string().trim().min(1).max(128).nullable(),
  })
  .strict();
export type ExpectedPrintDestination = z.infer<typeof ExpectedPrintDestinationSchema>;
export const PrintJobRequestSchema = PrintJobSchema.extend({
  expectedDestination: ExpectedPrintDestinationSchema.optional(),
});

export type PrintResult =
  | { status: 'PRINTED'; printerId: string; bytes: number; replayed: boolean }
  | { status: 'OFFLINE' | 'NO_PRINTER'; retryable: true; replayed: boolean };

export type PrintEnqueueResult =
  | { status: 'QUEUED'; printerId: string; replayed: boolean }
  | { status: 'PRINTED'; printerId: string; bytes: number; replayed: true }
  | { status: 'NO_PRINTER'; retryable: true; replayed: boolean };

export type ClaimedPrintJob = {
  id: string;
  /** Opaque 64 lowercase hex HMAC; echo unchanged to the authenticated ACK endpoint. */
  claimToken: string;
  printerId: string;
  documentType: PrintDocumentType;
  bytes: string;
};

export interface PrintBridgeAdapter {
  readonly kind: string;
  send(printerId: string, bytes: Uint8Array): Promise<'PRINTED' | 'OFFLINE'>;
}
