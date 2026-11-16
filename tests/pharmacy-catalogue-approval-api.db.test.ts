import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
import type { TRPCContext } from '@/server/trpc';

const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? '';
const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
// The mandatory approval audit writes are exercised against the real DB. Only
// unrelated automatic request logging is suppressed to keep this fixture bounded.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

(ownerUrl && runtimeUrl ? describe : describe.skip)(
  'DEV-766 catalogue API under restricted PostgreSQL runtime',
  () => {
    it('holds, separates, audits and publishes catalogue edits with fresh solo-owner PINs', async () => {
      assertDisposableRlsDatabase(ownerUrl);
      assertDisposableRlsDatabase(runtimeUrl);
      const { pharmacyMedicineRouter } = await import('@/server/routers/pharmacy-medicine');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');

      const c = new pg.Client({ connectionString: ownerUrl });
      await c.connect();
      try {
        const prefix = 'api_' + randomUUID().slice(0, 8);
        const id = (x: string) => prefix + '_' + x;
        await c.query("SELECT set_config('app.is_platform_admin','true',false)");
        for (const org of ['a', 'b', 'solo']) {
          await c.query(
            `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
            [id(org)]
          );
          await c.query(
            `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
            [id('dep_' + org), id(org)]
          );
          if (org === 'solo') {
            await c.query(
              `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'owner','Owner',true,now())`,
              [id('ownerrole'), id(org)]
            );
            await c.query(
              `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'*','ALLOW')`,
              [id('perm'), id(org), id('ownerrole')]
            );
          }
          for (const who of org === 'solo' ? ['owner'] : ['editor', 'reviewer']) {
            await c.query(
              `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,"updatedAt") VALUES ($1,$2,$3,$1,$1,'Pharmacy','Staff','ADMIN',now())`,
              [id(who + '_' + org), id(org), org === 'solo' ? id('ownerrole') : null]
            );
          }
          await c.query(
            `INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily",saleable,"updatedAt") VALUES ($1,$2,'Fixture lotion','FRONT_SHOP',true,now())`,
            [id('med_' + org), id(org)]
          );
        }
        await c.query(
          `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,'Fixture owner','ACTIVE',now())`,
          [id('staff'), id('solo'), id('owner_solo')]
        );
        await c.query(
          `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
          [id('credential'), id('solo'), id('staff'), await hashOperatorCredential('PIN', '2468')]
        );
        function caller(org: string, who: string) {
          return pharmacyMedicineRouter.createCaller({
            db: createTenantDb(id(org), id(who + '_' + org)),
            entitlements: {
              organizationId: id(org),
              enabledModules: ['pharmacy-core'],
              activeSeats: 2,
              seatLimit: 10,
              modules: [],
              limits: {},
            },
            session: {
              expires: 'later',
              user: {
                id: id(who + '_' + org),
                organizationId: id(org),
                role: 'ADMIN',
                status: 'ACTIVE',
              },
            },
            organization: null,
            support: null,
            requestMeta: { ip: null, userAgent: null },
            audit: { detail: {} },
          } as unknown as TRPCContext);
        }
        const editor = caller('a', 'editor'),
          reviewer = caller('a', 'reviewer'),
          foreign = caller('b', 'reviewer'),
          solo = caller('solo', 'owner');
        const runtime = createTenantDb(id('a'), id('editor_a'));
        const flags = await runtime.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
          'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
        );
        assert.deepEqual(flags, [{ rolsuper: false, rolbypassrls: false }]);
        const checks: string[] = [];
        async function refusal(p: Promise<unknown>, code: string) {
          await assert.rejects(p, (error: unknown) =>
            Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
          );
        }
        const edit = await editor.proposeCatalogueEdit({
          medicineId: id('med_a'),
          changes: { productName: 'Reviewed lotion' },
        });
        assert.equal(
          (
            await runtime.medicine.findFirstOrThrow({
              where: { id: id('med_a') },
            })
          ).productName,
          'Fixture lotion'
        );
        checks.push('durable pending edit leaves live catalogue unchanged');
        await refusal(
          editor.decideCatalogueEdit({
            editId: edit.id,
            decision: 'APPROVE',
            soloPin: '2468',
          }),
          'FORBIDDEN'
        );
        checks.push('editor cannot approve when another member exists');
        await refusal(
          foreign.decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' }),
          'NOT_FOUND'
        );
        checks.push('foreign tenant cannot read or decide edit');
        await reviewer.decideCatalogueEdit({
          editId: edit.id,
          decision: 'APPROVE',
        });
        assert.equal(
          (
            await runtime.medicine.findFirstOrThrow({
              where: { id: id('med_a') },
            })
          ).productName,
          'Reviewed lotion'
        );
        checks.push('different reviewer publishes and audits edit');
        const p1 = await editor.proposeCatalogueEdit({
          medicineId: id('med_a'),
          changes: { brandName: 'First brand' },
        });
        const p2 = await editor.proposeCatalogueEdit({
          medicineId: id('med_a'),
          changes: { brandName: 'Stale brand' },
        });
        await reviewer.decideCatalogueEdit({
          editId: p1.id,
          decision: 'APPROVE',
        });
        await refusal(
          reviewer.decideCatalogueEdit({ editId: p2.id, decision: 'APPROVE' }),
          'CONFLICT'
        );
        assert.equal(
          (
            await runtime.pharmacyCatalogueEdit.findFirstOrThrow({
              where: { id: p2.id },
            })
          ).status,
          'PENDING'
        );
        checks.push('stale publication rolls back proposal decision');
        const alias = await editor.addAlias({
          medicineId: id('med_a'),
          type: 'BRAND',
          value: 'Reviewed alias',
        });
        assert('status' in alias);
        assert.equal(
          await runtime.medicineAlias.count({
            where: { medicineId: id('med_a') },
          }),
          0
        );
        await reviewer.decideCatalogueEdit({
          editId: alias.id,
          decision: 'APPROVE',
        });
        assert.equal(
          await runtime.medicineAlias.count({
            where: { medicineId: id('med_a') },
          }),
          1
        );
        checks.push('published alias command stays pending until review');
        const se = await solo.proposeCatalogueEdit({
          medicineId: id('med_solo'),
          changes: { productName: 'Solo reviewed' },
        });
        await refusal(
          solo.decideCatalogueEdit({ editId: se.id, decision: 'APPROVE' }),
          'FORBIDDEN'
        );
        await refusal(
          solo.decideCatalogueEdit({
            editId: se.id,
            decision: 'APPROVE',
            soloPin: '9999',
          }),
          'FORBIDDEN'
        );
        const solodb = createTenantDb(id('solo'), id('owner_solo'));
        assert.equal(
          (
            await solodb.restaurantOperatorCredential.findFirstOrThrow({
              where: { id: id('credential') },
            })
          ).failedAttempts,
          1
        );
        await solo.decideCatalogueEdit({
          editId: se.id,
          decision: 'APPROVE',
          soloPin: '2468',
        });
        assert.equal(
          await solodb.auditLog.count({
            where: {
              action: 'pharmacy.catalogueSoloOwnerApproval',
              targetId: se.id,
            },
          }),
          1
        );
        checks.push('solo owner fresh PIN, durable failed guess and mandatory audit');
        const se2 = await solo.proposeCatalogueEdit({
          medicineId: id('med_solo'),
          changes: { brandName: 'Fresh again' },
        });
        await refusal(
          solo.decideCatalogueEdit({ editId: se2.id, decision: 'APPROVE' }),
          'FORBIDDEN'
        );
        checks.push('prior PIN verification does not authorize another edit');
        await c.query(
          `INSERT INTO users (id,"organizationId",name,email,department,title,"updatedAt") VALUES ($1,$2,$1,$1,'Pharmacy','Staff',now())`,
          [id('member_solo'), id('solo')]
        );
        await refusal(
          solo.decideCatalogueEdit({ editId: se2.id, decision: 'APPROVE', soloPin: '2468' }),
          'FORBIDDEN'
        );
        assert.equal(
          await solodb.auditLog.count({
            where: { action: 'pharmacy.catalogueSoloOwnerApproval', targetId: se2.id },
          }),
          0
        );
        checks.push('a true owner with another active member cannot self approve');

        const values = {
          productName: 'Fixture soap',
          dosageForm: 'Bottle',
          pack: '200 ml bottle',
        };
        const candidate = await editor.createMedicine({
          productName: 'Fixture soap',
          productFamily: 'FRONT_SHOP',
          provenance: Object.entries(values).map(([field, value]) => ({
            field,
            source: 'fixture',
            sourceType: 'USER',
            retrievedAt: new Date(),
            status: 'UNREVIEWED',
            assertedValue: {
              value,
              connectorId: 'manual-file',
              sourceLabel: 'Fixture',
              batchId: 'fixture-batch',
              rowSourceKey: 'fixture-row',
              rights: {
                acquisition: 'Fixture',
                cache: 'Fixture',
                redistribution: 'None',
                deletion: 'Fixture',
              },
              blockingIssues: [],
            },
          })),
        });
        const assertionIds = candidate.provenance.map((x) => x.id);
        await refusal(
          editor.recordReviewDecision({
            duplicateKey: 'fixture',
            action: 'ACCEPT',
            medicineIds: [candidate.id],
            payload: { assertionIds },
          }),
          'FORBIDDEN'
        );
        const decision = await reviewer.recordReviewDecision({
          duplicateKey: 'fixture',
          action: 'ACCEPT',
          medicineIds: [candidate.id],
          payload: { assertionIds },
        });
        const approvedIds = (decision.payload as { assertionIds: string[] }).assertionIds;
        await reviewer.publishAssertions({ assertionIds: approvedIds });
        assert.equal(
          (
            await runtime.medicine.findFirstOrThrow({
              where: { id: candidate.id },
            })
          ).saleable,
          true
        );
        assert.equal(
          await runtime.medicineStrengthComponent.count({
            where: { medicineId: candidate.id },
          }),
          0
        );
        checks.push('front-shop publication has reviewed provenance and no invented strength');
        assert.equal(checks.length, 10);
      } finally {
        await c.end();
      }
    }, 30_000);
  }
);
