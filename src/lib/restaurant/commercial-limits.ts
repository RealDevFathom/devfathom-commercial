import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import {
  POS_REGISTERED_DEVICES_LIMIT,
  POS_TERMINALS_LIMIT,
  RESTAURANT_OPERATORS_LIMIT,
  resolveEntitlementLimit,
  type EntitlementLimitDefinition,
} from '@/lib/entitlement-limits';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { enrollDevice } from './devices';
import { issuePrintBridgeEnrollmentCode } from './print-bridge-enrollment';
import {
  registerPrinterInventoryInTransaction,
  printerRegistrationsSchema,
  type PrinterRegistration,
} from './printer-inventory';
import {
  createStaffProfile,
  setStaffProfileStatus,
  updateStaffProfile,
  type CreateStaffProfileInput,
  type UpdateStaffProfileInput,
} from './staff';

export type CommercialLimitErrorReason = 'UNCONFIGURED' | 'LIMIT_REACHED';

export class CommercialLimitError extends Error {
  constructor(
    message: string,
    readonly reason: CommercialLimitErrorReason
  ) {
    super(message);
    this.name = 'CommercialLimitError';
  }
}

function configuredLimit(
  limits: Readonly<Record<string, number>>,
  definition: EntitlementLimitDefinition
): number {
  const resolution = resolveEntitlementLimit(limits, definition);
  if (resolution.status === 'missing') {
    throw new CommercialLimitError(
      `${definition.label} is not configured correctly.`,
      'UNCONFIGURED'
    );
  }
  return resolution.value;
}

function transactionScopedDb(db: ScopedDb, tx: Prisma.TransactionClient): ScopedDb {
  return new Proxy(db, {
    get(target, property, receiver) {
      switch (property) {
        case 'restaurantRegisteredDevice':
          return tx.restaurantRegisteredDevice;
        case 'restaurantStaffProfile':
          return tx.restaurantStaffProfile;
        case 'restaurantBranch':
          return tx.restaurantBranch;
        case 'user':
          return tx.user;
        default:
          return Reflect.get(target, property, receiver);
      }
    },
  });
}

async function lockOrganization(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM organizations WHERE id = current_setting('app.current_organization_id', true) FOR UPDATE`
  );
}

function limitReached(label: string, limit: number): never {
  throw new CommercialLimitError(
    `Your plan supports ${limit} active ${label}${limit === 1 ? '' : 's'}.`,
    'LIMIT_REACHED'
  );
}

export type CommercialDeviceInput = {
  branchId: string;
  name: string;
  kind?: 'POS' | 'KDS' | 'PRINT_BRIDGE';
  stationId?: string | null;
};

export async function enrollDeviceWithinCommercialLimits(
  db: ScopedDb,
  limits: Readonly<Record<string, number>>,
  input: CommercialDeviceInput
) {
  const registeredDevicesMax = configuredLimit(limits, POS_REGISTERED_DEVICES_LIMIT);
  const kind = input.kind ?? 'POS';
  const terminalsMax = kind === 'POS' ? configuredLimit(limits, POS_TERMINALS_LIMIT) : undefined;

  return db.$transaction(async (tx) => {
    const scopedTx = transactionScopedDb(db, tx);
    await lockOrganization(tx);
    const registeredDevices = await tx.restaurantRegisteredDevice.count({
      where: { status: 'ACTIVE' },
    });
    if (registeredDevices >= registeredDevicesMax) {
      limitReached('registered device', registeredDevicesMax);
    }
    if (terminalsMax !== undefined) {
      const terminals = await tx.restaurantRegisteredDevice.count({
        where: { status: 'ACTIVE', kind: 'POS' },
      });
      if (terminals >= terminalsMax) limitReached('POS terminal', terminalsMax);
    }
    return enrollDevice(scopedTx, input);
  });
}

async function assertOperatorCapacity(tx: ScopedDb, limit: number): Promise<void> {
  const operators = await tx.restaurantStaffProfile.count({ where: { status: 'ACTIVE' } });
  if (operators >= limit) limitReached('restaurant operator', limit);
}

export async function createStaffProfileWithinCommercialLimit(
  db: ScopedDb,
  limits: Readonly<Record<string, number>>,
  input: CreateStaffProfileInput
) {
  if (input.status !== undefined && input.status !== 'ACTIVE') {
    return createStaffProfile(db, input);
  }
  const operatorsMax = configuredLimit(limits, RESTAURANT_OPERATORS_LIMIT);
  return db.$transaction(async (tx) => {
    const scopedTx = transactionScopedDb(db, tx);
    await lockOrganization(tx);
    await assertOperatorCapacity(scopedTx, operatorsMax);
    return createStaffProfile(scopedTx, input);
  });
}

export async function updateStaffProfileWithinCommercialLimit(
  db: ScopedDb,
  limits: Readonly<Record<string, number>>,
  id: string,
  patch: UpdateStaffProfileInput
) {
  if (patch.status !== 'ACTIVE') return updateStaffProfile(db, id, patch);
  const operatorsMax = configuredLimit(limits, RESTAURANT_OPERATORS_LIMIT);
  return db.$transaction(async (tx) => {
    const scopedTx = transactionScopedDb(db, tx);
    await lockOrganization(tx);
    const current = await tx.restaurantStaffProfile.findUnique({
      where: { id },
      select: { status: true },
    });
    if (current?.status !== 'ACTIVE') await assertOperatorCapacity(scopedTx, operatorsMax);
    return updateStaffProfile(scopedTx, id, patch);
  });
}

export async function setStaffProfileStatusWithinCommercialLimit(
  db: ScopedDb,
  limits: Readonly<Record<string, number>>,
  id: string,
  status: Parameters<typeof setStaffProfileStatus>[2]
) {
  if (status !== 'ACTIVE') return setStaffProfileStatus(db, id, status);
  const operatorsMax = configuredLimit(limits, RESTAURANT_OPERATORS_LIMIT);
  return db.$transaction(async (tx) => {
    const scopedTx = transactionScopedDb(db, tx);
    await lockOrganization(tx);
    const current = await tx.restaurantStaffProfile.findUnique({
      where: { id },
      select: { status: true },
    });
    if (current?.status !== 'ACTIVE') await assertOperatorCapacity(scopedTx, operatorsMax);
    return setStaffProfileStatus(scopedTx, id, status);
  });
}

/** New bridges consume the registered-device allowance, never the POS-terminal allowance. */
export async function enrollPrintBridgeWithinCommercialLimits(
  db: ScopedDb,
  limits: Readonly<Record<string, number>>,
  input: { branchId: string; name: string; printers?: PrinterRegistration[] }
) {
  const printers =
    input.printers === undefined ? undefined : printerRegistrationsSchema.parse(input.printers);
  const maximum = configuredLimit(limits, POS_REGISTERED_DEVICES_LIMIT);
  return db.$transaction(async (tx) => {
    await lockOrganization(tx);
    const count = await tx.restaurantRegisteredDevice.count({ where: { status: 'ACTIVE' } });
    if (count >= maximum) limitReached('registered device', maximum);
    const { device } = await enrollDevice(transactionScopedDb(db, tx), {
      branchId: input.branchId,
      name: input.name,
      kind: 'PRINT_BRIDGE',
      stationId: null,
    });
    const printerCount = printers
      ? await registerPrinterInventoryInTransaction(tx, {
          branchId: input.branchId,
          bridgeId: device.id,
          printers,
        })
      : 0;
    // Use the actual transaction delegate, not the outer client's proxy fallback.
    const enrollment = await issuePrintBridgeEnrollmentCode(tx, device.id);
    return { device, enrollment, printerCount };
  });
}
