import { z } from 'zod';

export const PrintDocumentTypeSchema = z.enum(['KITCHEN_TICKET', 'BAR_TICKET', 'RECEIPT']);
export type PrintDocumentType = z.infer<typeof PrintDocumentTypeSchema>;

export const PrintLineSchema = z
  .object({ quantity: z.number().positive().max(999), label: z.string().trim().min(1).max(160) })
  .strict();

export const PrintDocumentSchema = z
  .object({
    type: PrintDocumentTypeSchema,
    reference: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(80),
    createdAt: z.string().datetime(),
    lines: z.array(PrintLineSchema).min(1).max(200),
    footer: z.string().trim().max(500).optional(),
  })
  .strict();
export type PrintDocument = z.infer<typeof PrintDocumentSchema>;

export const PrintRouteSchema = z
  .object({
    documentType: PrintDocumentTypeSchema,
    stationId: z.string().trim().min(1).max(128).nullable(),
    printerId: z.string().trim().min(1).max(128),
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

export type PrintResult =
  | { status: 'PRINTED'; printerId: string; bytes: number; replayed: boolean }
  | { status: 'OFFLINE' | 'NO_PRINTER'; retryable: true; replayed: boolean };

export type PrintEnqueueResult =
  | { status: 'QUEUED'; printerId: string; replayed: boolean }
  | { status: 'PRINTED'; printerId: string; bytes: number; replayed: true }
  | { status: 'NO_PRINTER'; retryable: true; replayed: boolean };

export type ClaimedPrintJob = {
  id: string;
  printerId: string;
  documentType: PrintDocumentType;
  bytes: string;
};

export interface PrintBridgeAdapter {
  readonly kind: string;
  send(printerId: string, bytes: Uint8Array): Promise<'PRINTED' | 'OFFLINE'>;
}
