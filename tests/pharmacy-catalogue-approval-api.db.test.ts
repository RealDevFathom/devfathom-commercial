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
            // DEV-19: approval is the exact pharmacy:catalogue-review grant.
            if (org !== 'solo')
              await c.query(
                `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW','fixture',now())`,
                [id('review_' + who + '_' + org), id(org), id(who + '_' + org)]
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
        assert.deepEqual(
          await reviewer.decideCatalogueEdit({
            editId: p1.id,
            decision: 'APPROVE',
          }),
          { id: p1.id, status: 'APPROVED', staleEdits: 1 }
        );
        assert.equal(
          (await reviewer.catalogueEdits()).find((row) => row.id === p2.id)?.stale,
          true
        );
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
        await reviewer.decideCatalogueEdit({ editId: p2.id, decision: 'REJECT' });

        // Hold the row so both decisions read it as PENDING before either writes;
        // only the status guard on the write can then stop both from applying.
        async function race(
          org: string,
          table: string,
          rowId: string,
          decisions: () => Promise<unknown>[]
        ) {
          await c.query('BEGIN');
          // Tenant tables force RLS, so the lock is taken inside the tenant's scope.
          await c.query("SELECT set_config('app.current_organization_id', $1, true)", [id(org)]);
          const held = await c.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [rowId]);
          assert.equal(held.rowCount, 1);
          const settled = Promise.allSettled(decisions());
          let waiting = 0;
          for (let attempt = 0; attempt < 400 && waiting < 2; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            waiting = (
              await c.query<{ n: number }>(
                'SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted'
              )
            ).rows[0]!.n;
          }
          await c.query('COMMIT');
          assert.equal(waiting, 2, 'both decisions must be blocked on the same row');
          const results = await settled;
          const won = results.filter((result) => result.status === 'fulfilled');
          const lost = results.filter((result) => result.status === 'rejected');
          assert.equal(won.length, 1);
          assert.equal(lost.length, 1);
          assert.equal(
            ((lost[0] as PromiseRejectedResult).reason as { code?: string }).code,
            'CONFLICT'
          );
          return results;
        }
        const contested = await editor.proposeCatalogueEdit({
          medicineId: id('med_a'),
          changes: { brandName: 'Contested brand' },
        });
        const [approval] = await race('a', 'pharmacy_catalogue_edits', contested.id, () => [
          reviewer.decideCatalogueEdit({ editId: contested.id, decision: 'APPROVE' }),
          reviewer.decideCatalogueEdit({ editId: contested.id, decision: 'REJECT' }),
        ]);
        const contestedRow = await runtime.pharmacyCatalogueEdit.findFirstOrThrow({
          where: { id: contested.id },
        });
        const brand = (await runtime.medicine.findFirstOrThrow({ where: { id: id('med_a') } }))
          .brandName;
        if (approval!.status === 'fulfilled') {
          assert.equal(contestedRow.status, 'APPROVED');
          assert.equal(brand, 'Contested brand');
        } else {
          assert.equal(contestedRow.status, 'REJECTED');
          assert.equal(brand, 'First brand');
        }
        checks.push('simultaneous approve and reject apply exactly one decision');

        // pharmacy:catalogue-review is an explicit grant (a wildcard does not
        // cover it). A rejection publishes nothing, so it needs no second person.
        await c.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW')`,
          [id('review_perm'), id('solo'), id('ownerrole')]
        );
        await c.query(
          `INSERT INTO pharmacy_reference_connectors (id,"organizationId",key,label,schedule,"createdBy","updatedAt") VALUES ($1,$2,'manual-file','Fixture file','{}',$3,now())`,
          [id('connector'), id('solo'), id('owner_solo')]
        );
        await c.query(
          `INSERT INTO pharmacy_reference_connector_runs (id,"organizationId","connectorId","inputDigest","batchId","fileName","triggerKind","triggeredBy") VALUES ($1,$2,$3,'digest','batch','fixture.csv','MANUAL',$4)`,
          [id('run'), id('solo'), id('connector'), id('owner_solo')]
        );
        await c.query(
          `INSERT INTO pharmacy_reference_connector_proposals (id,"organizationId","runId","connectorId","inputDigest","rowSourceKey",payload) VALUES ($1,$2,$3,$4,'digest','row-1','{}')`,
          [id('proposal'), id('solo'), id('run'), id('connector')]
        );
        await race('solo', 'pharmacy_reference_connector_proposals', id('proposal'), () => [
          solo.decideReferenceConnectorProposal({
            proposalId: id('proposal'),
            decision: 'REJECT',
          }),
          solo.decideReferenceConnectorProposal({
            proposalId: id('proposal'),
            decision: 'REJECT',
          }),
        ]);
        assert.equal(
          (
            await createTenantDb(
              id('solo'),
              id('owner_solo')
            ).pharmacyReferenceConnectorProposal.findFirstOrThrow({
              where: { id: id('proposal') },
            })
          ).status,
          'REJECTED'
        );
        checks.push('simultaneous connector decisions apply exactly one');
        const ingredient = await editor.createIngredient({ name: prefix + ' ingredient' });
        assert('status' in ingredient);
        assert.equal(ingredient.medicineId, null);
        assert.equal(
          await runtime.ingredient.count({ where: { name: prefix + ' ingredient' } }),
          0
        );
        await reviewer.decideCatalogueEdit({ editId: ingredient.id, decision: 'APPROVE' });
        assert.equal(
          await runtime.ingredient.count({ where: { name: prefix + ' ingredient' } }),
          1
        );
        checks.push('new ingredient stays pending until review (DEV-19)');
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
        // DEV-19: the exception ends once another active member can review.
        await c.query(
          `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW','fixture',now())`,
          [id('review_member_solo'), id('solo'), id('member_solo')]
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
        checks.push('a true owner with another active reviewer cannot self approve');

        // DEV-19: an Owner and a Cashier, nobody else can review. The owner approves
        // their own edit with a fresh PIN; the approval is audited with its reason.
        const pair = 'pair';
        await c.query(
          `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
          [id(pair)]
        );
        await c.query(
          `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
          [id('dep_' + pair), id(pair)]
        );
        await c.query(
          `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'owner','Owner',true,now())`,
          [id('pair_owner_role'), id(pair)]
        );
        await c.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:*','ALLOW')`,
          [id('pair_owner_perm'), id(pair), id('pair_owner_role')]
        );
        await c.query(
          `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'cashier','Cashier',true,now())`,
          [id('pair_cashier_role'), id(pair)]
        );
        await c.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:counter','ALLOW')`,
          [id('pair_cashier_perm'), id(pair), id('pair_cashier_role')]
        );
        await c.query(
          `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,"updatedAt") VALUES ($1,$2,$3,$1,$1,'Pharmacy','Staff','ADMIN',now()),($4,$2,$5,$4,$4,'Pharmacy','Staff','EMPLOYEE',now())`,
          [
            id('owner_' + pair),
            id(pair),
            id('pair_owner_role'),
            id('cashier_' + pair),
            id('pair_cashier_role'),
          ]
        );
        await c.query(
          `INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily",saleable,"updatedAt") VALUES ($1,$2,'Fixture balm','FRONT_SHOP',true,now())`,
          [id('med_' + pair), id(pair)]
        );
        await c.query(
          `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,'Fixture pair owner','ACTIVE',now())`,
          [id('pair_staff'), id(pair), id('owner_' + pair)]
        );
        await c.query(
          `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
          [
            id('pair_credential'),
            id(pair),
            id('pair_staff'),
            await hashOperatorCredential('PIN', '1357'),
          ]
        );
        const pairOwner = caller(pair, 'owner');
        const pe = await pairOwner.proposeCatalogueEdit({
          medicineId: id('med_' + pair),
          changes: { productName: 'Owner reviewed balm' },
        });
        await refusal(
          pairOwner.decideCatalogueEdit({ editId: pe.id, decision: 'APPROVE' }),
          'FORBIDDEN'
        );
        await pairOwner.decideCatalogueEdit({
          editId: pe.id,
          decision: 'APPROVE',
          soloPin: '1357',
        });
        const pairdb = createTenantDb(id(pair), id('owner_' + pair));
        assert.equal(
          (await pairdb.medicine.findFirstOrThrow({ where: { id: id('med_' + pair) } }))
            .productName,
          'Owner reviewed balm'
        );
        const pairAudit = await pairdb.auditLog.findMany({
          where: { action: 'pharmacy.catalogueSoloOwnerApproval', targetId: pe.id },
        });
        assert.equal(pairAudit.length, 1);
        assert.deepEqual(pairAudit[0]!.metadata, {
          soloOwner: true,
          pinVerified: true,
          reason: 'no other reviewer',
        });
        checks.push('owner approves with a fresh PIN when only a cashier could otherwise review');

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
        assert.equal(checks.length, 14);
      } finally {
        await c.end();
      }
    }, 30_000);
  }
);
