// @vitest-environment node
// Requires a migrated TEST_DATABASE_URL using a NOSUPERUSER NOBYPASSRLS role.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PharmacyPharmacovigilanceReport } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '');
const organizationId = `pv_race_${suffix}`;
const branchId = `pv_branch_${suffix}`;
const actorId = `pv_actor_${suffix}`;
const initialRevision = new Date('2020-01-01T00:00:00.000Z');
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let reportsRouter: typeof import('./pharmacy-reports').pharmacyReportsRouter;
let flushAudits: typeof import('../audit').flushAuditWritesForTest;

function caller(db: ScopedDb) {
  return reportsRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-core', 'pharmacy-reports'],
      modules: [],
    },
    session: {
      expires: '2099-01-01',
      user: { id: actorId, role: 'EMPLOYEE', status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId, vertical: 'PHARMACY', status: 'ACTIVE' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

function tenant<T>(run: (db: ScopedDb) => Promise<T>) {
  return withTenantDb(
    organizationId,
    async (db) => {
      await db.$queryRaw`SELECT set_config('app.current_branch_id', ${branchId}, true)`;
      return run(db);
    },
    { userId: actorId }
  );
}

function seed(externalSubmissionState: 'NOT_SUBMITTED' | 'PENDING' | 'FAILED' = 'NOT_SUBMITTED') {
  return tenant((db) =>
    db.pharmacyPharmacovigilanceReport.create({
      data: {
        organizationId,
        branchId,
        kind: 'ADVERSE_DRUG_REACTION',
        state: 'READY',
        externalSubmissionState,
        externalFailureReason: externalSubmissionState === 'FAILED' ? 'Original failure' : null,
        occurredAt: initialRevision,
        assertedDescription: 'Synthetic safety evidence',
        createdByUserId: actorId,
        updatedAt: initialRevision,
      },
    })
  );
}

const read = (id: string) =>
  tenant((db) => db.pharmacyPharmacovigilanceReport.findUniqueOrThrow({ where: { id } }));

// Pause only after each real SELECT has completed. All authorization, writes,
// row locks, @updatedAt values, and audits use the real application/database code.
function synchronizeReads() {
  let arrived = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  return (db: ScopedDb) =>
    new Proxy(db, {
      get(target, key, receiver) {
        if (key !== 'pharmacyPharmacovigilanceReport') return Reflect.get(target, key, receiver);
        return new Proxy(target.pharmacyPharmacovigilanceReport, {
          get(delegate, operation, delegateReceiver) {
            if (operation !== 'findFirst')
              return Reflect.get(delegate, operation, delegateReceiver);
            return async (
              args: Parameters<ScopedDb['pharmacyPharmacovigilanceReport']['findFirst']>[0]
            ) => {
              const row = await delegate.findFirst(args);
              if (++arrived === 2) release();
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  bothRead,
                  new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                      () => reject(new Error('Second reader did not arrive')),
                      5000
                    );
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
              return row;
            };
          },
        });
      },
    });
}

async function race(
  id: string,
  actions: Array<(api: ReturnType<typeof caller>) => Promise<PharmacyPharmacovigilanceReport>>
) {
  await flushAudits();
  const priorAudits = await tenant((db) =>
    db.auditLog.findMany({ where: { input: { path: ['id'], equals: id } }, select: { id: true } })
  );
  const synchronized = synchronizeReads();
  // Each request owns a separate PostgreSQL transaction/connection.
  const results = await Promise.allSettled(
    actions.map((action) => tenant((db) => action(caller(synchronized(db)))))
  );
  const winners = results.filter((result) => result.status === 'fulfilled');
  expect(winners).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
    { reason: { code: 'CONFLICT' } },
  ]);
  const winner = winners[0]!.value;
  expect(winner.updatedAt.getTime()).toBeGreaterThan(initialRevision.getTime());
  expect(await read(id)).toEqual(winner);
  expect(winner.assertedDescription).toBe('Synthetic safety evidence');

  await flushAudits();
  const audits = await tenant((db) =>
    db.auditLog.findMany({
      where: {
        input: { path: ['id'], equals: id },
        id: { notIn: priorAudits.map((audit) => audit.id) },
      },
    })
  );
  expect(audits.map((audit) => audit.outcome).sort()).toEqual(['FAILURE', 'SUCCESS']);
  expect(audits.find((audit) => audit.outcome === 'FAILURE')?.errorCode).toBe('CONFLICT');
  return winner;
}

suite('pharmacovigilance concurrency on PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
    ({ pharmacyReportsRouter: reportsRouter } = await import('./pharmacy-reports'));
    ({ flushAuditWritesForTest: flushAudits } = await import('../audit'));
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(withPlatformDb);
    await withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          legalName: 'Safety concurrency fixture',
          displayName: 'Safety concurrency fixture',
          vertical: 'PHARMACY',
          status: 'ACTIVE',
        },
      })
    );
    await tenant(async (db) => {
      await db.organizationDepartment.create({
        data: { organizationId, key: 'Pharmacy', name: 'Pharmacy' },
      });
      await db.user.create({
        data: {
          id: actorId,
          organizationId,
          name: 'Safety reviewer',
          email: `${actorId}@example.test`,
          department: 'Pharmacy',
          title: 'Pharmacist',
        },
      });
      await db.userPermissionOverride.create({
        data: {
          organizationId,
          userId: actorId,
          capability: 'pharmacy:safety',
          effect: 'ALLOW',
          reason: 'Safety concurrency fixture',
        },
      });
      await db.pharmacyBranch.create({
        data: {
          id: branchId,
          organizationId,
          code: 'MAIN',
          name: 'Main',
          addressLine: '1 Test Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      await db.pharmacyBranchAssignment.create({
        data: { organizationId, branchId, userId: actorId },
      });
    });
  }, 30_000);

  afterAll(async () => {
    await flushAudits?.();
    const { db } = await import('@/lib/db');
    await db.$disconnect();
    // Retain append-only clinical reports and their audits in the disposable DB.
  });

  it('commits exactly one of two competing lifecycle transitions', async () => {
    const report = await seed();
    await race(
      report.id,
      (['SUBMITTED', 'CLOSED'] as const).map(
        (state) => (api) =>
          api.transitionPharmacovigilanceReport({ id: report.id, branchId, state })
      )
    );
  });

  it.each(['NOT_SUBMITTED', 'PENDING', 'FAILED'] as const)(
    'preserves the winning external evidence from %s',
    async (externalState) => {
      const report = await seed(externalState);
      await race(report.id, [
        (api) =>
          api.recordPharmacovigilanceSubmission({
            id: report.id,
            branchId,
            state: 'SUBMITTED',
            externalReference: 'DRAP-WINNER',
          }),
        (api) =>
          api.recordPharmacovigilanceSubmission({
            id: report.id,
            branchId,
            state: 'FAILED',
            failureReason: 'Endpoint unavailable',
          }),
      ]);
    }
  );

  it('preserves the winning failure reason for competing FAILED self-transitions', async () => {
    const report = await seed('FAILED');
    await race(
      report.id,
      ['Failure A', 'Failure B'].map(
        (failureReason) => (api) =>
          api.recordPharmacovigilanceSubmission({
            id: report.id,
            branchId,
            state: 'FAILED',
            failureReason,
          })
      )
    );
  });

  it('arbitrates a lifecycle closure racing an external outcome using the row revision', async () => {
    const report = await seed('PENDING');
    await race(report.id, [
      (api) => api.transitionPharmacovigilanceReport({ id: report.id, branchId, state: 'CLOSED' }),
      (api) =>
        api.recordPharmacovigilanceSubmission({
          id: report.id,
          branchId,
          state: 'SUBMITTED',
          externalReference: 'DRAP-RACE',
        }),
    ]);
  });

  it.each(['CLOSED', 'UNDER_REVIEW', 'DRAFT'] as const)(
    'records exactly one pending outcome after internal state changes to %s',
    async (state) => {
      const report = await seed();
      await tenant(async (db) => {
        const api = caller(db);
        await api.recordPharmacovigilanceSubmission({
          id: report.id,
          branchId,
          state: 'PENDING',
        });
        await api.transitionPharmacovigilanceReport({
          id: report.id,
          branchId,
          state: state === 'DRAFT' ? 'UNDER_REVIEW' : state,
        });
        if (state === 'DRAFT') {
          await api.transitionPharmacovigilanceReport({ id: report.id, branchId, state });
        }
      });
      const winner = await race(report.id, [
        (api) =>
          api.recordPharmacovigilanceSubmission({
            id: report.id,
            branchId,
            state: 'SUBMITTED',
            externalReference: 'DRAP-OUTCOME',
          }),
        (api) =>
          api.recordPharmacovigilanceSubmission({
            id: report.id,
            branchId,
            state: 'FAILED',
            failureReason: 'Submission rejected',
          }),
      ]);
      expect(winner.state).toBe(state);
    }
  );
});
