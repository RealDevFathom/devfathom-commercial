import 'server-only';

import { can, type Subject } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  commitEntityRows,
  rollbackImportedEntities,
  type CreatedEntity,
  type EntityImportWriter,
  type ImportCommitContext,
  type ImportEntityRow,
} from './entity-committers';

export type ImportBatchRecord = { status: string; organizationId: string; branchId: string };
export interface EntityImportRepository {
  /** Starts one tenant transaction. Implementations must use this transaction for writer and repository. */
  transaction<T>(work: (repository: EntityImportRepository, writer: EntityImportWriter) => Promise<T>): Promise<T>;
  batchForUpdate(batchId: string): Promise<ImportBatchRecord | null>;
  rows(batchId: string): Promise<ImportEntityRow[]>;
  openBlockingCount(batchId: string): Promise<number>;
  manifest(batchId: string): Promise<CreatedEntity[]>;
  stockLocationBelongsToBranch(stockLocationId: string, branchId: string): Promise<boolean>;
  loyaltyDecision(batchId: string, actorId: string): Promise<{ enabled: boolean } | null>;
  hasOwnerAuthority(actorId: string): Promise<boolean>;
  /** Atomic compare-and-set; false means another request won the race. */
  transition(batchId: string, from: string, to: 'COMMITTING' | 'COMMITTED' | 'ROLLED_BACK'): Promise<boolean>;
}

export type AuthenticatedImportContext = Omit<ImportCommitContext, 'actorId' | 'organizationId'>;

async function authorize(subject: Subject, db: ScopedDb): Promise<void> {
  if (!(await can(subject, 'pharmacy:data-import', undefined, { db }))) throw new Error('Forbidden');
}

function scope(batch: ImportBatchRecord, subject: Subject, organizationId: string, context: AuthenticatedImportContext) {
  if (batch.organizationId !== organizationId || batch.branchId !== context.branchId)
    throw new Error('Import batch is outside the authenticated branch scope.');
  return { ...context, actorId: subject.id, organizationId };
}

/** Authorization precedes every repository read. All commit effects occur in one transaction. */
export async function commitImportBatch(
  subject: Subject,
  db: ScopedDb,
  organizationId: string,
  repository: EntityImportRepository,
  context: AuthenticatedImportContext
): Promise<CreatedEntity[]> {
  await authorize(subject, db);
  return repository.transaction(async (tx, writer) => {
    const batch = await tx.batchForUpdate(context.batchId);
    if (!batch || batch.status !== 'PREVIEW') throw new Error('Only a previewed batch can be committed.');
    const commitContext = scope(batch, subject, organizationId, context);
    if (!(await tx.stockLocationBelongsToBranch(context.stockLocationId, batch.branchId)))
      throw new Error('Stock location is outside the import branch.');
    if (context.awardImportedLoyalty) {
      if (!(await tx.hasOwnerAuthority(subject.id)) || !(await tx.loyaltyDecision(context.batchId, subject.id))?.enabled)
        throw new Error('Persisted owner approval is required for imported loyalty.');
    }
    if (!(await tx.transition(context.batchId, 'PREVIEW', 'COMMITTING'))) throw new Error('Import batch changed concurrently.');
    // Re-check after claiming the row so exceptions inserted before the lock are observed.
    const blocking = await tx.openBlockingCount(context.batchId);
    if (blocking) throw new Error('Resolve every blocking preview error before commit.');
    const created = await commitEntityRows(writer, commitContext, await tx.rows(context.batchId), blocking);
    if (!(await tx.transition(context.batchId, 'COMMITTING', 'COMMITTED'))) throw new Error('Import batch changed concurrently.');
    return created;
  });
}

/** Authorization precedes manifest access; rollback and compensations are one transaction. */
export async function rollbackImportBatch(subject: Subject, db: ScopedDb, organizationId: string, repository: EntityImportRepository, context: AuthenticatedImportContext): Promise<void> {
  await authorize(subject, db);
  await repository.transaction(async (tx, writer) => {
    const batch = await tx.batchForUpdate(context.batchId);
    if (!batch || batch.status !== 'COMMITTED') throw new Error('Only a committed batch can be rolled back.');
    const commitContext = scope(batch, subject, organizationId, context);
    await rollbackImportedEntities(writer, commitContext, await tx.manifest(context.batchId));
    if (!(await tx.transition(context.batchId, 'COMMITTED', 'ROLLED_BACK'))) throw new Error('Import batch changed concurrently.');
  });
}
