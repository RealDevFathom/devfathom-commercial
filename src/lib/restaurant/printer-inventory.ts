import 'server-only';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { resolveTransport } from './printing/target';

function connectionKind(address: string) {
  // Queue names may target either supported host; device paths require POSIX.
  const target = resolveTransport(address, /^queue:/i.test(address) ? 'win32' : 'linux');
  return target.kind === 'tcp' ? 'TCP' as const : target.kind === 'queue' ? 'QUEUE' as const : 'DEVICE_PATH' as const;
}
export const printerRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(128).refine((value) => { try { connectionKind(value); return true; } catch { return false; } }, 'Use a supported explicit TCP, installed queue, or POSIX /dev/ target.'),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]),
}).strict();
export const printerRegistrationsSchema = z.array(printerRegistrationSchema).min(1).max(20);
export type PrinterRegistration = z.infer<typeof printerRegistrationSchema>;
export class PrinterInventoryError extends Error {}
export const publicPrinterSelect = {
  id: true, branchId: true, bridgeId: true, name: true, connectionKind: true, address: true,
  paperWidthMm: true, status: true, lastSeenAt: true, lastError: true, createdAt: true, updatedAt: true,
  bridge: { select: { id: true, name: true, kind: true, status: true, revokedAt: true } },
} as const satisfies Prisma.RestaurantPrinterSelect;

/** The caller owns this transaction; issuance and inventory can share the same commit. */
export async function registerPrinterInventoryInTransaction(tx: Prisma.TransactionClient, input: {
  branchId: string; bridgeId: string; printers: readonly PrinterRegistration[];
}) {
  const printers = printerRegistrationsSchema.parse(input.printers);
  const branches = await tx.$queryRaw<Array<{ id: string; active: boolean }>>`
    SELECT id, active FROM restaurant_branches
    WHERE id = ${input.branchId} AND "organizationId" = current_setting('app.current_organization_id', true)
    FOR SHARE`;
  if (!branches[0]?.active) throw new PrinterInventoryError('Active branch not found.');
  const bridges = await tx.$queryRaw<Array<{ id: string; branchId: string; kind: string; status: string; revokedAt: Date | null }>>`
    SELECT id, "branchId", kind, status, "revokedAt" FROM restaurant_registered_devices
    WHERE id = ${input.bridgeId} AND "organizationId" = current_setting('app.current_organization_id', true)
    FOR UPDATE`;
  const bridge = bridges[0];
  if (!bridge || bridge.branchId !== input.branchId || bridge.kind !== 'PRINT_BRIDGE' || bridge.status !== 'ACTIVE' || bridge.revokedAt !== null)
    throw new PrinterInventoryError('Active print bridge not found in this branch.');
  const result = await tx.restaurantPrinter.createMany({ data: printers.map((printer) => ({
    branchId: input.branchId, bridgeId: input.bridgeId, name: printer.name,
    address: printer.address, connectionKind: connectionKind(printer.address), paperWidthMm: printer.paperWidthMm,
  })) });
  return result.count;
}

export function registerPrintersForExistingBridge(db: ScopedDb, input: {
  branchId: string; bridgeId: string; printers: readonly PrinterRegistration[];
}) {
  // Parse before opening the write transaction, then recheck ownership inside it.
  const printers = printerRegistrationsSchema.parse(input.printers);
  return db.$transaction((tx) => registerPrinterInventoryInTransaction(tx, { ...input, printers }));
}
