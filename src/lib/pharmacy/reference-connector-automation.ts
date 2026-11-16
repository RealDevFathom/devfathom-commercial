import 'server-only';

import { createHash } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  DRAP_REGISTRY_CONNECTOR_ID,
  DRAP_REGISTRY_LABEL,
  DRAP_REGISTRY_RIGHTS,
  MANUAL_FILE_RIGHTS,
  type ConnectorRights,
  type ConnectorSchedule,
  type MedicineReferenceField,
  type NormalizedMedicineReferenceRow,
} from './reference-connectors';

export const MAX_CONNECTOR_ROWS_PER_CALL = 100;

export const DIRECT_REFERENCE_FIELDS = ['brandName', 'manufacturer'] as const;
export const REGULATED_REFERENCE_FIELDS = [
  'productName',
  'drapRegistrationNumber',
  'strength',
  'dosageForm',
  'pack',
  'barcode',
  'alias',
  'rx',
  'restricted',
  'controlled',
] as const satisfies readonly MedicineReferenceField[];

export type ReferenceConnectorKey = 'manual-file' | typeof DRAP_REGISTRY_CONNECTOR_ID;

type ReferenceConnectorDescriptor = {
  key: ReferenceConnectorKey;
  label: string;
  digestAdapter: string;
  sourceType: 'IMPORT' | 'REGULATOR';
  rights: ConnectorRights;
  /** Official sources match existing medicines by registration number and never write directly. */
  official: boolean;
};

export const REFERENCE_CONNECTORS: Record<ReferenceConnectorKey, ReferenceConnectorDescriptor> = {
  'manual-file': {
    key: 'manual-file',
    label: 'Manual CSV / Excel',
    digestAdapter: 'MANUAL_FILE',
    sourceType: 'IMPORT',
    rights: MANUAL_FILE_RIGHTS,
    official: false,
  },
  [DRAP_REGISTRY_CONNECTOR_ID]: {
    key: DRAP_REGISTRY_CONNECTOR_ID,
    label: DRAP_REGISTRY_LABEL,
    digestAdapter: 'DRAP_REGISTRY_FILE',
    sourceType: 'REGULATOR',
    rights: DRAP_REGISTRY_RIGHTS,
    official: true,
  },
};

type RunInput = {
  connectorKey?: ReferenceConnectorKey;
  organizationId: string;
  actorId: string;
  triggerKind: 'MANUAL' | 'SCHEDULED_CALL';
  batchId: string;
  fileName: string;
  rows: NormalizedMedicineReferenceRow[];
};

type Rejection = { rowSourceKey: string; reasons: string[] };

function sortedValues(values: NormalizedMedicineReferenceRow['values']) {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
  );
}

export function manualConnectorInputDigest(
  input: Pick<RunInput, 'fileName' | 'rows' | 'connectorKey'>
): string {
  const canonical = {
    adapter: REFERENCE_CONNECTORS[input.connectorKey ?? 'manual-file'].digestAdapter,
    fileName: input.fileName,
    rows: input.rows.map((row) => ({
      rowSourceKey: row.rowSourceKey,
      targetMedicineId: row.targetMedicineId ?? null,
      values: sortedValues(row.values),
      blockingIssues: [...row.blockingIssues].sort(),
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function priorRejections(value: Prisma.JsonValue): Rejection[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Rejection =>
    Boolean(
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof item.rowSourceKey === 'string' &&
      Array.isArray(item.reasons) &&
      item.reasons.every((reason) => typeof reason === 'string')
    )
  );
}

function boolValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value.toLowerCase() === 'true';
}

function regulatedChanges(
  row: NormalizedMedicineReferenceRow,
  target: {
    productName: string;
    drapRegistrationNumber: string | null;
    rx: boolean;
    restricted: boolean;
    controlled: boolean;
  } | null
) {
  const changes: Partial<Record<MedicineReferenceField, string>> = {};
  for (const field of REGULATED_REFERENCE_FIELDS) {
    const value = row.values[field];
    if (value === undefined) continue;
    if (!target) {
      changes[field] = value;
      continue;
    }
    const current =
      field === 'productName' || field === 'drapRegistrationNumber'
        ? target[field]
        : field === 'rx' || field === 'restricted' || field === 'controlled'
          ? String(target[field])
          : undefined;
    if (current === undefined || String(current) !== value) changes[field] = value;
  }
  return changes;
}

export async function configureManualReferenceConnector(
  db: ScopedDb,
  input: {
    organizationId: string;
    actorId: string;
    label: string;
    enabled: boolean;
    schedule: ConnectorSchedule;
  }
) {
  return db.pharmacyReferenceConnector.upsert({
    where: {
      organizationId_key: { organizationId: input.organizationId, key: 'manual-file' },
    },
    create: {
      organizationId: input.organizationId,
      key: 'manual-file',
      label: input.label,
      adapter: 'MANUAL_FILE',
      enabled: input.enabled,
      schedule: asJson(input.schedule),
      createdBy: input.actorId,
    },
    update: {
      label: input.label,
      enabled: input.enabled,
      schedule: asJson(input.schedule),
    },
  });
}

export async function runManualReferenceConnector(
  db: ScopedDb | Prisma.TransactionClient,
  input: RunInput
) {
  const descriptor = REFERENCE_CONNECTORS[input.connectorKey ?? 'manual-file'];
  const inputDigest = manualConnectorInputDigest(input);
  await db.$queryRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    `pharmacy-reference:${input.organizationId}:${inputDigest}`
  );

  const connector = await db.pharmacyReferenceConnector.upsert({
    where: {
      organizationId_key: { organizationId: input.organizationId, key: descriptor.key },
    },
    create: {
      organizationId: input.organizationId,
      key: descriptor.key,
      label: descriptor.label,
      adapter: 'MANUAL_FILE',
      enabled: true,
      schedule: { kind: 'MANUAL' },
      createdBy: input.actorId,
    },
    update: {},
  });
  // Told to the operator who started the import, so a deliberate TRPCError.
  if (!connector.enabled)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: descriptor.official
        ? 'DRAP registry reference connector is disabled.'
        : 'Manual reference connector is disabled.',
    });

  const completed = await db.pharmacyReferenceConnectorRun.findFirst({
    where: { connectorId: connector.id, inputDigest, status: 'COMPLETED' },
    orderBy: { startedAt: 'desc' },
  });
  if (completed) {
    const replay = await db.pharmacyReferenceConnectorRun.create({
      data: {
        connectorId: connector.id,
        inputDigest,
        batchId: input.batchId,
        fileName: input.fileName,
        status: 'COMPLETED',
        triggerKind: input.triggerKind,
        triggeredBy: input.actorId,
        replayOfRunId: completed.id,
        cursorStart: input.rows.length,
        cursorEnd: input.rows.length,
        rowsSeen: input.rows.length,
        rowsSkipped: input.rows.length,
        rejectionReasons: [],
        completedAt: new Date(),
      },
    });
    await db.pharmacyReferenceConnector.update({
      where: { id: connector.id },
      data: {
        cursor: { inputDigest, offset: input.rows.length },
        lastRunState: 'COMPLETED',
        lastRunAt: replay.completedAt,
      },
    });
    return { ...replay, noOp: true, proposalRows: 0 };
  }

  let run = await db.pharmacyReferenceConnectorRun.findFirst({
    where: { connectorId: connector.id, inputDigest, status: 'RUNNING' },
    orderBy: { startedAt: 'desc' },
  });
  if (!run) {
    run = await db.pharmacyReferenceConnectorRun.create({
      data: {
        connectorId: connector.id,
        inputDigest,
        batchId: input.batchId,
        fileName: input.fileName,
        triggerKind: input.triggerKind,
        triggeredBy: input.actorId,
        rejectionReasons: [],
      },
    });
  }

  const start = run.cursorEnd;
  const end = Math.min(start + MAX_CONNECTOR_ROWS_PER_CALL, input.rows.length);
  const chunk = input.rows.slice(start, end);
  const seenKeys = new Set(input.rows.slice(0, start).map((row) => row.rowSourceKey));
  let rowsApplied = 0;
  let rowsSkipped = 0;
  let rowsRejected = 0;
  const directFieldsApplied = 0;
  let regulatedFieldsProposed = 0;
  let proposalRows = 0;
  const rejections = priorRejections(run.rejectionReasons);

  for (const row of chunk) {
    const reasons: string[] = [...row.blockingIssues];
    if (seenKeys.has(row.rowSourceKey)) reasons.push('DUPLICATE_ROW_SOURCE_KEY');
    seenKeys.add(row.rowSourceKey);
    if (reasons.length) {
      rowsRejected += 1;
      rejections.push({ rowSourceKey: row.rowSourceKey, reasons: [...new Set(reasons)] });
      continue;
    }

    const targetSelect = {
      id: true,
      productName: true,
      brandName: true,
      manufacturer: true,
      drapRegistrationNumber: true,
      rx: true,
      restricted: true,
      controlled: true,
    } as const;
    let target = row.targetMedicineId
      ? await db.medicine.findFirst({ where: { id: row.targetMedicineId }, select: targetSelect })
      : null;
    if (row.targetMedicineId && !target) {
      rowsRejected += 1;
      rejections.push({ rowSourceKey: row.rowSourceKey, reasons: ['TARGET_MEDICINE_NOT_FOUND'] });
      continue;
    }
    // Official registry rows pre-fill the catalogue entry that already carries their
    // registration number, so a pharmacist reviews an update instead of a duplicate.
    const registration = row.values.drapRegistrationNumber;
    if (!target && descriptor.official && registration) {
      const matches = await db.medicine.findMany({
        where: { drapRegistrationNumber: registration },
        select: targetSelect,
        take: 2,
      });
      if (matches.length > 1) {
        rowsRejected += 1;
        rejections.push({
          rowSourceKey: row.rowSourceKey,
          reasons: ['AMBIGUOUS_DRAP_REGISTRATION'],
        });
        continue;
      }
      target = matches[0] ?? null;
    }

    const proposed = regulatedChanges(row, target);
    for (const field of DIRECT_REFERENCE_FIELDS) {
      const value = row.values[field];
      if (value === undefined) continue;
      // Descriptive edits also wait for an independent catalogue review (DEV-766).
      if (!target || target[field] !== value) proposed[field] = value;
    }
    if (Object.keys(proposed).length) {
      await db.pharmacyReferenceConnectorProposal.create({
        data: {
          runId: run.id,
          connectorId: connector.id,
          inputDigest,
          rowSourceKey: row.rowSourceKey,
          targetMedicineId: target?.id,
          payload: asJson({
            values: proposed,
            source: {
              connectorId: descriptor.key,
              label: descriptor.label,
              fileName: input.fileName,
              batchId: input.batchId,
              rowSourceKey: row.rowSourceKey,
              rights: descriptor.rights,
            },
          }),
        },
      });
      proposalRows += 1;
      regulatedFieldsProposed += Object.keys(proposed).length;
    } else {
      rowsSkipped += 1;
    }
  }

  const done = end === input.rows.length;
  const finishedAt = done ? new Date() : null;
  run = await db.pharmacyReferenceConnectorRun.update({
    where: { id: run.id },
    data: {
      status: done ? 'COMPLETED' : 'RUNNING',
      cursorEnd: end,
      rowsSeen: run.rowsSeen + chunk.length,
      rowsApplied: run.rowsApplied + rowsApplied,
      rowsSkipped: run.rowsSkipped + rowsSkipped,
      rowsRejected: run.rowsRejected + rowsRejected,
      directFieldsApplied: run.directFieldsApplied + directFieldsApplied,
      regulatedFieldsProposed: run.regulatedFieldsProposed + regulatedFieldsProposed,
      rejectionReasons: asJson(rejections),
      completedAt: finishedAt,
    },
  });
  await db.pharmacyReferenceConnector.update({
    where: { id: connector.id },
    data: {
      cursor: { inputDigest, offset: end },
      lastRunState: run.status,
      lastRunAt: finishedAt ?? new Date(),
    },
  });
  return { ...run, noOp: false, proposalRows };
}

export function proposedBoolean(value: string | undefined): boolean | undefined {
  return boolValue(value);
}
