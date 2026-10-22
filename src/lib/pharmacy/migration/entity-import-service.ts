import 'server-only';

import {
  commitEntityRows,
  rollbackImportedEntities,
  type CreatedEntity,
  type EntityImportWriter,
  type ImportCommitContext,
  type ImportEntityRow,
} from './entity-committers';

export interface EntityImportRepository {
  batch(batchId: string): Promise<{ status: string } | null>;
  rows(batchId: string): Promise<ImportEntityRow[]>;
  openBlockingCount(batchId: string): Promise<number>;
  manifest(batchId: string): Promise<CreatedEntity[]>;
  setStatus(batchId: string, status: 'COMMITTING' | 'COMMITTED' | 'ROLLED_BACK'): Promise<void>;
}

/** Must run inside the caller's tenant transaction with its writer and repository. */
export async function commitImportBatch(
  repository: EntityImportRepository,
  writer: EntityImportWriter,
  context: ImportCommitContext
): Promise<CreatedEntity[]> {
  const batch = await repository.batch(context.batchId);
  if (!batch || batch.status !== 'PREVIEW') throw new Error('Only a previewed batch can be committed.');
  const blocking = await repository.openBlockingCount(context.batchId);
  if (blocking !== 0) throw new Error('Resolve every blocking preview error before commit.');
  await repository.setStatus(context.batchId, 'COMMITTING');
  const created = await commitEntityRows(writer, context, await repository.rows(context.batchId), blocking);
  await repository.setStatus(context.batchId, 'COMMITTED');
  return created;
}

/** Manifest is the exclusive rollback allow-list; pre-existing IDs are never considered. */
export async function rollbackImportBatch(
  repository: EntityImportRepository,
  writer: EntityImportWriter,
  context: ImportCommitContext
): Promise<void> {
  const batch = await repository.batch(context.batchId);
  if (!batch || batch.status !== 'COMMITTED') throw new Error('Only a committed batch can be rolled back.');
  await rollbackImportedEntities(writer, context, await repository.manifest(context.batchId));
  await repository.setStatus(context.batchId, 'ROLLED_BACK');
}
