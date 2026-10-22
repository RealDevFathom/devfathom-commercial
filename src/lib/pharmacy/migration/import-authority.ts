import 'server-only';

/**
 * Import 1/5 — the one door into every import write and every branch-scoped import read.
 *
 * `enterImportBranch` asks central `can()` for `pharmacy:data-import` (persisted role and user
 * overrides; an explicit DENY wins), checks the branch belongs to the organization and that the
 * actor may work in it, and only then binds `app.current_branch_id` for the transaction. The
 * PH-MIG tables are forced-RLS on organization AND branch, so a statement issued without this
 * binding sees and writes nothing. Every exported import mutation calls it itself: a caller that
 * skips the tRPC capability procedure still meets the same check.
 */
import { Prisma } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const REASONS = {
  FORBIDDEN: 'Importing pharmacy data needs the data-import permission.',
  BRANCH_OUT_OF_SCOPE: 'Choose an active branch you are assigned to.',
  BATCH_NOT_FOUND: 'That import batch is not in this branch.',
  BATCH_LEGACY:
    'This batch predates branch-scoped imports. A platform operator must assign it to a branch first.',
  BATCH_NOT_PREVIEW: 'Only a batch in preview can be committed.',
  BATCH_NOT_COMMITTED: 'Only a committed batch can be rolled back.',
  BATCH_ROLLED_BACK: 'This batch has already been rolled back.',
  BLOCKING_EXCEPTIONS: 'Sign off every blocking exception before committing this batch.',
  ROW_NOT_IN_BATCH: 'A commit instruction names a row that is not in this batch.',
  DUPLICATE_INSTRUCTION: 'Each row and target can be committed only once per request.',
  INVALID_INSTRUCTION: 'A commit instruction is missing a valid value.',
  REFERENCE_OUT_OF_SCOPE:
    'A commit instruction names a batch, pack or location outside this branch.',
  CONTROLLED_NOT_IMPORTABLE:
    'Controlled medicines open through the controlled register, not through an import.',
  COLD_CHAIN_REQUIRED: 'A cold-chain medicine can only open into a validated cold-chain location.',
  BATCH_NOT_ACTIVE: 'A recalled or quarantined manufacturing batch cannot open as available stock.',
  SUPPLIER_CONFLICT:
    'A supplier with that name was created at the same moment. Commit again to use it.',
  ROLLBACK_BLOCKED: 'This import can no longer be rolled back.',
  MANIFEST_INCONSISTENT: 'The import manifest does not match the ledger; nothing was changed.',
  EXCEPTION_NOT_FOUND: 'No open exception with that identifier in this branch.',
  ASYNC_REQUIRED: 'Files of 2 MiB or more are imported by the background scheduler.',
} as const;

export type PharmacyImportReason = keyof typeof REASONS;

export class PharmacyImportError extends Error {
  constructor(
    readonly reason: PharmacyImportReason,
    /** For ROLLBACK_BLOCKED: one sentence per manifest entry that blocks the rollback. */
    readonly details: readonly string[] = []
  ) {
    super(REASONS[reason]);
    this.name = 'PharmacyImportError';
  }
}

/** Who asks, for which branch. `role` is the session role (ADMIN reaches every active branch). */
export type ImportRequest = {
  organizationId: string;
  branchId: string;
  actor: { userId: string; role?: string | null };
};

export type ImportScope = {
  readonly organizationId: string;
  readonly branchId: string;
  readonly actorId: string;
};

/**
 * Run `work` in one transaction of `db`, or inside the caller's when `db` already is one (the
 * tenant client reuses an open interactive transaction). The branch binding lives exactly as
 * long as this transaction.
 */
export function inImportTransaction<T>(
  db: ScopedDb,
  work: (tx: ScopedDb) => Promise<T>
): Promise<T> {
  return db.$transaction((tx) => work(tx as unknown as ScopedDb), {
    maxWait: 10_000,
    timeout: 120_000,
  });
}

/** Central can() for pharmacy:data-import; an explicit DENY wins over any role grant. */
export async function hasImportCapability(
  db: ScopedDb,
  actor: ImportRequest['actor']
): Promise<boolean> {
  return can(
    { id: actor.userId, role: actor.role ?? 'EMPLOYEE' },
    'pharmacy:data-import',
    undefined,
    {
      db,
    }
  );
}

/**
 * Authorize, then bind the branch for the rest of `tx`. Must run inside the transaction that
 * does the work: the binding is transaction-local.
 */
export async function enterImportBranch(
  tx: ScopedDb,
  request: ImportRequest
): Promise<ImportScope> {
  if (!(await hasImportCapability(tx, request.actor))) throw new PharmacyImportError('FORBIDDEN');
  await bindImportBranch(tx, request);
  return {
    organizationId: request.organizationId,
    branchId: request.branchId,
    actorId: request.actor.userId,
  };
}

/** Branch checks and the RLS binding, for reads gated by a caller's own capability check. */
export async function bindImportBranch(tx: ScopedDb, request: ImportRequest): Promise<void> {
  const branch = await tx.pharmacyBranch.findFirst({
    where: { id: request.branchId, organizationId: request.organizationId, active: true },
    select: { id: true },
  });
  if (!branch) throw new PharmacyImportError('BRANCH_OUT_OF_SCOPE');
  if (request.actor.role !== 'ADMIN') {
    const assignment = await tx.pharmacyBranchAssignment.findFirst({
      where: {
        organizationId: request.organizationId,
        branchId: request.branchId,
        userId: request.actor.userId,
        active: true,
      },
      select: { id: true },
    });
    if (!assignment) throw new PharmacyImportError('BRANCH_OUT_OF_SCOPE');
  }
  await tx.$queryRaw(
    Prisma.sql`SELECT set_config('app.current_branch_id', ${request.branchId}, true)`
  );
}

/** Active branches the actor may import into or review: all for ADMIN, else assignments. */
export async function importBranchIds(
  db: ScopedDb,
  request: Omit<ImportRequest, 'branchId'>
): Promise<string[]> {
  if (request.actor.role === 'ADMIN') {
    const branches = await db.pharmacyBranch.findMany({
      where: { organizationId: request.organizationId, active: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return branches.map((branch) => branch.id);
  }
  const assignments = await db.pharmacyBranchAssignment.findMany({
    where: {
      organizationId: request.organizationId,
      userId: request.actor.userId,
      active: true,
      branch: { active: true },
    },
    select: { branchId: true },
    orderBy: { branchId: 'asc' },
  });
  return assignments.map((assignment) => assignment.branchId);
}
