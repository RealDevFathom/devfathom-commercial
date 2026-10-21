/**
 * The readiness probe against a real, fully migrated PostgreSQL database.
 *
 * This is the half of the proof that a mock cannot give: that the probe's two
 * reads are ones an unprivileged runtime role is actually allowed to make, that
 * `organizations.vertical` really is selectable through the generated client at
 * this schema, and that the SQLSTATE the route classifies on is the SQLSTATE
 * PostgreSQL returns. The failure paths are in `route.test.ts`.
 *
 * Gated on `TEST_DATABASE_URL` the way every database-backed suite here is, and
 * assigned into `DATABASE_URL` before the route is imported, because
 * `@/lib/db` reads the connection string when its module is evaluated.
 */
import { describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('GET /api/ready against a migrated database', () => {
  it('reports the schema as current', async () => {
    const { GET } = await import('./route');

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', schema: 'current' });
  });

  it('connects as a role that neither is a superuser nor bypasses row level security', async () => {
    const { db } = await import('@/lib/db');

    const roles = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;

    // Either attribute would let the probe read straight through the policy on
    // `organizations`, which would make the tenant-neutrality assertion below
    // pass for the wrong reason.
    expect(roles[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('proves the column without reading a tenant row', async () => {
    const { db } = await import('@/lib/db');

    // `organizations` is under FORCE ROW LEVEL SECURITY and the probe sets no
    // `app.current_organization_id`, so the query must plan and execute — which
    // is what proves the column — and return nothing.
    await expect(db.organization.findFirst({ select: { vertical: true } })).resolves.toBeNull();
  });

  it('sees every migration finished and none rolled back', async () => {
    const { db } = await import('@/lib/db');

    const rows = await db.$queryRaw<Array<{ pending: number; applied: number }>>`
      SELECT count(*) FILTER (
               WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL
             )::int AS pending,
             count(*)::int AS applied
        FROM "_prisma_migrations"
    `;

    expect(rows[0]?.pending).toBe(0);
    // Guards against a vacuous pass on a database with an empty ledger.
    expect(rows[0]?.applied).toBeGreaterThan(0);
  });

  it('raises 42703 for a column PostgreSQL does not have, which is what the route classifies on', async () => {
    const { db } = await import('@/lib/db');
    const { Prisma } = await import('@/generated/prisma/client');

    const error =
      await db.$queryRaw`SELECT "column_the_schema_does_not_have" FROM "organizations" LIMIT 1`.then(
        () => null,
        (caught: unknown) => caught
      );

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const meta = (error as InstanceType<typeof Prisma.PrismaClientKnownRequestError>).meta as {
      driverAdapterError?: { cause?: { originalCode?: string } };
    };
    expect(meta?.driverAdapterError?.cause?.originalCode).toBe('42703');
  });
});
