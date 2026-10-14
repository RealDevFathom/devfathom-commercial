import 'server-only';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { resolveTransport } from './printing/target';

function connectionKind(address: string) {
  // Queue names may target either supported host; device paths require POSIX.
  const target = resolveTransport(address, /^queue:/i.test(address) ? 'win32' : 'linux');
  return target.kind === 'tcp'
    ? ('TCP' as const)
    : target.kind === 'queue'
      ? ('QUEUE' as const)
      : ('DEVICE_PATH' as const);
}
export const printerRegistrationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    address: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((value) => {
        try {
          connectionKind(value);
          return true;
        } catch {
          return false;
        }
      }, 'Use a supported explicit TCP, installed queue, or POSIX /dev/ target.'),
    paperWidthMm: z.union([z.literal(58), z.literal(80)]),
  })
  .strict();
export const printerRegistrationsSchema = z.array(printerRegistrationSchema).min(1).max(20);
export type PrinterRegistration = z.infer<typeof printerRegistrationSchema>;
export class PrinterInventoryError extends Error {}
export const publicPrinterSelect = {
  id: true,
  branchId: true,
  bridgeId: true,
  name: true,
  connectionKind: true,
  address: true,
  paperWidthMm: true,
  status: true,
  lastSeenAt: true,
  lastError: true,
  retiredAt: true,
  createdAt: true,
  updatedAt: true,
  bridge: { select: { id: true, name: true, kind: true, status: true, revokedAt: true } },
} as const satisfies Prisma.RestaurantPrinterSelect;

/** The caller owns this transaction; issuance and inventory can share the same commit. */
export async function registerPrinterInventoryInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    branchId: string;
    bridgeId: string;
    printers: readonly PrinterRegistration[];
  }
) {
  const printers = printerRegistrationsSchema.parse(input.printers);
  const branches = await tx.$queryRaw<Array<{ id: string; active: boolean }>>`
    SELECT id, active FROM restaurant_branches
    WHERE id = ${input.branchId} AND "organizationId" = current_setting('app.current_organization_id', true)
    FOR SHARE`;
  if (!branches[0]?.active) throw new PrinterInventoryError('Active branch not found.');
  const bridges = await tx.$queryRaw<
    Array<{ id: string; branchId: string; kind: string; status: string; revokedAt: Date | null }>
  >`
    SELECT id, "branchId", kind, status, "revokedAt" FROM restaurant_registered_devices
    WHERE id = ${input.bridgeId} AND "organizationId" = current_setting('app.current_organization_id', true)
    FOR UPDATE`;
  const bridge = bridges[0];
  if (
    !bridge ||
    bridge.branchId !== input.branchId ||
    bridge.kind !== 'PRINT_BRIDGE' ||
    bridge.status !== 'ACTIVE' ||
    bridge.revokedAt !== null
  )
    throw new PrinterInventoryError('Active print bridge not found in this branch.');
  const result = await tx.restaurantPrinter.createMany({
    data: printers.map((printer) => ({
      branchId: input.branchId,
      bridgeId: input.bridgeId,
      name: printer.name,
      address: printer.address,
      connectionKind: connectionKind(printer.address),
      paperWidthMm: printer.paperWidthMm,
    })),
  });
  return result.count;
}

export function registerPrintersForExistingBridge(
  db: ScopedDb,
  input: {
    branchId: string;
    bridgeId: string;
    printers: readonly PrinterRegistration[];
  }
) {
  // Parse before opening the write transaction, then recheck ownership inside it.
  const printers = printerRegistrationsSchema.parse(input.printers);
  return db.$transaction((tx) => registerPrinterInventoryInTransaction(tx, { ...input, printers }));
}

export const printerRenameSchema = z
  .object({
    branchId: z.string().min(1),
    printerId: z.string().min(1),
    // Preserve the comparison value exactly, including legacy whitespace.
    expectedName: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export class PrinterRenameError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND',
    message: string
  ) {
    super(message);
  }
}

/** Label correction never changes transport, routing, credentials or observed health. */
export function renamePrinterInventory(db: ScopedDb, value: z.infer<typeof printerRenameSchema>) {
  const input = printerRenameSchema.parse(value);
  return db.$transaction(async (tx) => {
    const branches = await tx.$queryRaw<Array<{ id: string; active: boolean }>>`
      SELECT id, active FROM restaurant_branches
      WHERE id = ${input.branchId} AND "organizationId" = current_setting('app.current_organization_id', true)
      FOR SHARE`;
    if (!branches[0]?.active) throw new PrinterRenameError('FORBIDDEN', 'Active branch not found.');
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        organizationId: string;
        branchId: string;
        bridgeId: string;
        name: string;
      }>
    >`
      SELECT id, "organizationId", "branchId", "bridgeId", name FROM restaurant_printers
      WHERE id = ${input.printerId} AND "branchId" = ${input.branchId}
        AND "organizationId" = current_setting('app.current_organization_id', true)
      FOR UPDATE`;
    const printer = rows[0];
    if (!printer) throw new PrinterRenameError('NOT_FOUND', 'Printer not found in this branch.');
    // Compare before no-op: seeing the desired name is not proof of a previous request.
    if (printer.name !== input.expectedName)
      throw new PrinterRenameError(
        'CONFLICT',
        'Printer name changed. Refresh and review before saving.'
      );
    const changed = printer.name !== input.name;
    if (changed) {
      const result = await tx.restaurantPrinter.updateMany({
        where: {
          id: printer.id,
          organizationId: printer.organizationId,
          branchId: input.branchId,
          name: input.expectedName,
        },
        data: { name: input.name },
      });
      if (result.count !== 1)
        throw new PrinterRenameError(
          'CONFLICT',
          'Printer name changed. Refresh and review before saving.'
        );
    }
    return {
      printer: { id: printer.id, branchId: printer.branchId, name: input.name },
      changed,
      bridgeId: printer.bridgeId,
      previousName: printer.name,
    };
  });
}

export const printerRetirementSchema = z
  .object({ branchId: z.string().min(1), printerId: z.string().min(1) })
  .strict();
export class PrinterRetirementError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND',
    message: string
  ) {
    super(message);
  }
}

/** Monotonic lifecycle only: retain transport, observed health, routes and job history. */
export function retirePrinterInventory(
  db: ScopedDb,
  value: z.infer<typeof printerRetirementSchema>
) {
  const input = printerRetirementSchema.parse(value);
  return db.$transaction(
    async (tx) => {
      // A scoped nested transaction reuses its outer transaction and may ignore options.
      // Verify the actual isolation before any lock, blocker observation or write.
      const isolation = await tx.$queryRaw<Array<{ isolation: string }>>`
      SELECT current_setting('transaction_isolation') AS isolation`;
      if (isolation[0]?.isolation !== 'read committed')
        throw new PrinterRetirementError(
          'CONFLICT',
          'Printer retirement requires a ReadCommitted transaction.'
        );
      const branches = await tx.$queryRaw<Array<{ id: string; active: boolean }>>`
      SELECT id, active FROM restaurant_branches
      WHERE id = ${input.branchId} AND "organizationId" = current_setting('app.current_organization_id', true)
      FOR UPDATE`;
      if (!branches[0]?.active)
        throw new PrinterRetirementError('FORBIDDEN', 'Active branch not found.');
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          organizationId: string;
          branchId: string;
          bridgeId: string;
          name: string;
          retiredAt: Date | null;
        }>
      >`
      SELECT id, "organizationId", "branchId", "bridgeId", name, "retiredAt" FROM restaurant_printers
      WHERE id = ${input.printerId} AND "branchId" = ${input.branchId}
        AND "organizationId" = current_setting('app.current_organization_id', true)
      FOR UPDATE`;
      const printer = rows[0];
      if (!printer)
        throw new PrinterRetirementError('NOT_FOUND', 'Printer not found in this branch.');
      const result = (retiredAt: Date, changed: boolean) => ({
        printer: { id: printer.id, branchId: printer.branchId, name: printer.name, retiredAt },
        bridgeId: printer.bridgeId,
        changed,
      });
      // A stable repeat is not an assertion that later anomalies do not exist.
      if (printer.retiredAt !== null) return result(printer.retiredAt, false);
      const scope = {
        organizationId: printer.organizationId,
        branchId: input.branchId,
        registeredPrinterId: printer.id,
      };
      const route = await tx.restaurantPrintRoute.findFirst({ where: scope, select: { id: true } });
      if (route)
        throw new PrinterRetirementError(
          'CONFLICT',
          'Remove all registered print routes before retiring this printer.'
        );
      const job = await tx.restaurantPrintJob.findFirst({
        where: { ...scope, status: { not: 'PRINTED' } },
        select: { id: true },
      });
      if (job)
        throw new PrinterRetirementError(
          'CONFLICT',
          'Resolve all unfinished registered print jobs before retiring this printer.'
        );
      const retiredAt = new Date();
      const updated = await tx.restaurantPrinter.updateMany({
        where: {
          id: printer.id,
          organizationId: printer.organizationId,
          branchId: input.branchId,
          retiredAt: null,
        },
        data: { retiredAt },
      });
      if (updated.count !== 1)
        throw new PrinterRetirementError(
          'CONFLICT',
          'Printer changed. Refresh and review before retiring.'
        );
      return result(retiredAt, true);
    },
    { isolationLevel: 'ReadCommitted' }
  );
}
