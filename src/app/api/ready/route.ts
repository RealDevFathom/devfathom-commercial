/**
 * The readiness probe, as distinct from the liveness probe at `/api/health`.
 *
 * `SELECT 1` proves that a connection can be opened. It does not prove that the
 * database behind that connection holds the schema this build was compiled
 * against, so `/api/health` returned 200 throughout a staging deploy in which
 * every page failed with P2022 (`organizations.vertical` missing on a database
 * that had not been migrated). A probe that cannot fail the way the application
 * fails is not a probe.
 *
 * This route therefore runs the two reads that would have caught it:
 *
 *   1. pending or half-applied migrations — a deploy that stopped part-way
 *      leaves a `_prisma_migrations` row with no `finished_at` and no
 *      `rolled_back_at`, and the container must not take traffic in that state;
 *   2. one bounded, tenant-neutral read through the GENERATED client that
 *      selects a recent column. Going through `prisma.organization.findFirst`
 *      rather than raw SQL is the point: it is the generated client's view of
 *      the schema that drifts, and P2022 is raised while planning the query,
 *      before any row is filtered.
 *
 * Deliberately NOT proven here: that any row comes back. `organizations` is
 * under FORCE ROW LEVEL SECURITY and its policy keys on
 * `app.current_organization_id`, which this route never sets. The read is
 * expected to return `null`, and that is the tenant-neutral behaviour we want —
 * readiness must not depend on a tenant existing, and must not bypass row level
 * security to find one.
 *
 * The failure body carries a short code and nothing else. As the P2022 message
 * above demonstrates, a Prisma error text can contain the failing SQL, the
 * model, the source file and surrounding source lines; none of that belongs in
 * a response that is served without authentication.
 */
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * The probe must answer inside the orchestrator's own probe timeout rather than
 * hang until it. A 5 s readiness probe timeout is typical; answering
 * 503 at 2 s makes a stalled database a reported failure instead of a probe
 * timeout, which is the difference between a diagnosable reason code and none.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * PostgreSQL SQLSTATEs that mean "the object this build asked for is not in the
 * deployed schema": `42P01` undefined_table, `42703` undefined_column. Raw
 * queries surface these under Prisma's generic `P2010`, so the SQLSTATE has to
 * be read out of the driver adapter cause to tell drift from an outage.
 */
const SCHEMA_DRIFT_SQLSTATES = new Set(['42P01', '42703']);

/**
 * Prisma error codes for the same condition on a typed client call: `P2021`
 * table does not exist, `P2022` column does not exist. P2022 is the code the
 * staging deploy returned.
 */
const SCHEMA_DRIFT_PRISMA_CODES = new Set(['P2021', 'P2022']);

type UnreadyReason =
  | 'runtime_role_privileged'
  | 'migrations_pending'
  | 'schema_drift'
  | 'timeout'
  | 'database_unavailable';

class ProbeTimeoutError extends Error {}

/** Read the SQLSTATE the driver adapter reported, if this error carries one. */
function driverSqlState(error: Prisma.PrismaClientKnownRequestError): string | undefined {
  const adapterError = error.meta?.driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null) return undefined;

  const cause = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;

  const originalCode = (cause as { originalCode?: unknown }).originalCode;
  return typeof originalCode === 'string' ? originalCode : undefined;
}

/**
 * Separate "the schema is wrong" from "the database is unreachable". Both are
 * 503, but only the first is fixed by running migrations, and an operator
 * reading a probe log should not have to guess which one they have.
 */
function classify(error: unknown): UnreadyReason {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (SCHEMA_DRIFT_PRISMA_CODES.has(error.code)) return 'schema_drift';

    const sqlState = driverSqlState(error);
    if (sqlState && SCHEMA_DRIFT_SQLSTATES.has(sqlState)) return 'schema_drift';
  }

  return 'database_unavailable';
}

/** Resolve to the reason the deployment is not ready, or `null` when it is. */
async function probeSchema(): Promise<UnreadyReason | null> {
  const roles = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
    SELECT rolsuper, rolbypassrls
      FROM pg_roles
     WHERE rolname = current_user
  `;

  const role = roles[0];
  if (!role || role.rolsuper || role.rolbypassrls) return 'runtime_role_privileged';

  const migrations = await db.$queryRaw<Array<{ pending: number }>>`
    SELECT count(*)::int AS pending
      FROM "_prisma_migrations"
     WHERE "finished_at" IS NULL
       AND "rolled_back_at" IS NULL
  `;

  if ((migrations[0]?.pending ?? 0) > 0) return 'migrations_pending';

  await db.organization.findFirst({ select: { vertical: true } });

  return null;
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Racing leaves `work` with a rejection handler attached even when the
    // timer wins, so a late database error cannot become an unhandled rejection.
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError()), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  let reason: UnreadyReason | null;

  try {
    reason = await withTimeout(probeSchema());
  } catch (error) {
    reason = error instanceof ProbeTimeoutError ? 'timeout' : classify(error);
  }

  const headers = { 'cache-control': 'no-store' };

  if (reason) {
    // The reason code only. Logging the error itself would put the failing SQL
    // and the database host into the container log for every probe interval.
    console.error(`[ready] readiness probe failed: ${reason}`);
    return Response.json({ status: 'unavailable', reason }, { status: 503, headers });
  }

  return Response.json({ status: 'ok', schema: 'current' }, { headers });
}
