import 'server-only';

import { MIGRATION_TARGET_KEYS } from './mapping-targets';

export type ImportEntityRow = {
  id: string;
  sourceKey: string;
  targetModelKey: string;
  rawPayload: unknown;
};

export type ImportCommitContext = {
  batchId: string;
  actorId: string;
  organizationId: string;
  branchId: string;
  stockLocationId: string;
  awardImportedLoyalty: boolean;
};

export type CreatedEntity = {
  entityType: string;
  entityId: string;
  operation: 'CREATED' | 'STOCK_MOVEMENT';
  movementKind?: 'OPENING';
  /** Stable identity includes the branch and prevents cross-branch replay. */
  branchId?: string;
  lotKey?: string;
};

/** Stable retry key for every row operation; lot distinguishes split opening stock. */
export function entityOperationIdempotencyKey(context: ImportCommitContext, row: ImportEntityRow, operation: CreatedEntity['operation'], lotKey = ''): string {
  return ['pharmacy-import', context.batchId, context.branchId, row.sourceKey, operation, lotKey].map(encodeURIComponent).join(':');
}

export interface EntityImportWriter {
  product(row: ImportEntityRow, context: ImportCommitContext): Promise<CreatedEntity[]>;
  customer(row: ImportEntityRow, context: ImportCommitContext): Promise<CreatedEntity[]>;
  supplier(row: ImportEntityRow, context: ImportCommitContext): Promise<CreatedEntity[]>;
  historicalSale(row: ImportEntityRow, context: ImportCommitContext): Promise<CreatedEntity[]>;
  manifest(row: ImportEntityRow, context: ImportCommitContext, entity: CreatedEntity): Promise<void>;
  audit(action: string, context: ImportCommitContext, metadata: Record<string, unknown>): Promise<void>;
  remove(entity: CreatedEntity, context: ImportCommitContext): Promise<void>;
  reverseOpeningMovement(entity: CreatedEntity, context: ImportCommitContext): Promise<string>;
}

export type EntityCommitter = (
  writer: EntityImportWriter,
  row: ImportEntityRow,
  context: ImportCommitContext
) => Promise<CreatedEntity[]>;

const invoke = (method: 'product' | 'customer' | 'supplier' | 'historicalSale'): EntityCommitter =>
  (writer, row, context) => writer[method](row, context);

/** The single registry used by commit; a target key can never silently choose an adapter. */
export const entityCommitterRegistry: Readonly<Record<string, EntityCommitter>> = Object.freeze({
  [MIGRATION_TARGET_KEYS.PRODUCT]: invoke('product'),
  [MIGRATION_TARGET_KEYS.CUSTOMER]: invoke('customer'),
  [MIGRATION_TARGET_KEYS.SUPPLIER]: invoke('supplier'),
  [MIGRATION_TARGET_KEYS.HISTORY_DOCUMENT]: invoke('historicalSale'),
});

export async function commitEntityRows(
  writer: EntityImportWriter,
  context: ImportCommitContext,
  rows: readonly ImportEntityRow[],
  unresolvedBlockingErrors: number
): Promise<CreatedEntity[]> {
  if (unresolvedBlockingErrors > 0) throw new Error('Resolve every blocking preview error before commit.');
  const created: CreatedEntity[] = [];
  for (const row of rows) {
    const committer = entityCommitterRegistry[row.targetModelKey];
    if (!committer) throw new Error(`No entity committer registered for ${row.targetModelKey}.`);
    const entities = await committer(writer, row, context);
    for (const entity of entities) {
      if (entity.operation === 'STOCK_MOVEMENT' && entity.movementKind !== 'OPENING')
        throw new Error('Imported stock may be posted only as an OPENING movement.');
      await writer.manifest(row, context, { ...entity, branchId: context.branchId, lotKey: entity.lotKey ?? '' });
      created.push(entity);
    }
  }
  await writer.audit('pharmacy.import.commit', context, { created: created.length });
  return created;
}

export async function rollbackImportedEntities(
  writer: EntityImportWriter,
  context: ImportCommitContext,
  entities: readonly CreatedEntity[]
): Promise<void> {
  for (const entity of [...entities].reverse()) {
    if (entity.operation === 'STOCK_MOVEMENT') await writer.reverseOpeningMovement(entity, context);
    else await writer.remove(entity, context);
  }
  await writer.audit('pharmacy.import.rollback', context, { entities: entities.length });
}
