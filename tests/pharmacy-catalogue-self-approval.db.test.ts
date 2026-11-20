import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
import type { TRPCContext } from '@/server/trpc';

const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? '';
const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
// Only unrelated automatic request logging is suppressed; approval audits are real writes.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

(ownerUrl && runtimeUrl ? describe : describe.skip)(
  'DEV-976 who can approve an owner’s own catalogue edit, under restricted PostgreSQL runtime',
  () => {
    it('agrees with the decision when another reviewer exists and when the owner is alone', async () => {
      assertDisposableRlsDatabase(ownerUrl);
      assertDisposableRlsDatabase(runtimeUrl);
      const { pharmacyMedicineRouter } = await import('@/server/routers/pharmacy-medicine');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');

      const c = new pg.Client({ connectionString: ownerUrl });
      await c.connect();
      try {
        const prefix = 'selfok_' + randomUUID().slice(0, 8);
        const id = (x: string) => prefix + '_' + x;
        await c.query("SELECT set_config('app.is_platform_admin','true',false)");
        // pair: the owner and a pharmacist both hold the review grant, as in the owner's report.
        // solo: the owner is the only member. other: a separate pharmacy with its own reviewer.
        const people: Record<string, Array<[string, string, string]>> = {
          pair: [
            ['owner', 'Saad Owner', 'ACTIVE'],
            ['pharmacist', 'Ayesha Khan', 'ACTIVE'],
            ['former', 'Former Pharmacist', 'INACTIVE'],
            ['cashier', 'Cashier Fixture', 'ACTIVE'],
          ],
          solo: [['owner', 'Solo Owner', 'ACTIVE']],
          other: [['pharmacist', 'Other Pharmacy Reviewer', 'ACTIVE']],
        };
        for (const org of Object.keys(people)) {
          await c.query(
            `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
            [id(org)]
          );
          await c.query(
            `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
            [id('dep_' + org), id(org)]
          );
          await c.query(
            `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'owner','Owner',true,now())`,
            [id('ownerrole_' + org), id(org)]
          );
          await c.query(
            `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'*','ALLOW')`,
            [id('perm_' + org), id(org), id('ownerrole_' + org)]
          );
          for (const [who, name, status] of people[org]!) {
            const userId = id(who + '_' + org);
            await c.query(
              `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,status,"updatedAt") VALUES ($1,$2,$3,$4,$1,'Pharmacy','Staff',$5,$6,now())`,
              [
                userId,
                id(org),
                who === 'owner' ? id('ownerrole_' + org) : null,
                name,
                who === 'owner' ? 'ADMIN' : 'EMPLOYEE',
                status,
              ]
            );
            if (org === 'pair' ? who !== 'cashier' : who === 'pharmacist')
              await c.query(
                `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW','fixture',now())`,
                [id('review_' + who + '_' + org), id(org), userId]
              );
            if (who === 'owner') {
              await c.query(
                `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,'Fixture owner','ACTIVE',now())`,
                [id('staff_' + org), id(org), userId]
              );
              await c.query(
                `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
                [
                  id('credential_' + org),
                  id(org),
                  id('staff_' + org),
                  await hashOperatorCredential('PIN', '2468'),
                ]
              );
            }
          }
          await c.query(
            `INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily",saleable,"updatedAt") VALUES ($1,$2,'Fixture lotion','FRONT_SHOP',true,now())`,
            [id('med_' + org), id(org)]
          );
        }
        function caller(org: string, who: string) {
          const userId = id(who + '_' + org);
          return pharmacyMedicineRouter.createCaller({
            db: createTenantDb(id(org), userId),
            entitlements: {
              organizationId: id(org),
              enabledModules: ['pharmacy-core'],
              activeSeats: 4,
              seatLimit: 10,
              modules: [],
              limits: {},
            },
            session: {
              expires: 'later',
              user: {
                id: userId,
                organizationId: id(org),
                role: who === 'owner' ? 'ADMIN' : 'EMPLOYEE',
                status: 'ACTIVE',
              },
            },
            organization: null,
            support: null,
            requestMeta: { ip: null, userAgent: null },
            audit: { detail: {} },
          } as unknown as TRPCContext);
        }
        const runtime = createTenantDb(id('pair'), id('owner_pair'));
        const flags = await runtime.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
          'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
        );
        assert.deepEqual(flags, [{ rolsuper: false, rolbypassrls: false }]);
        async function refusal(p: Promise<unknown>, code: string) {
          await assert.rejects(p, (error: unknown) =>
            Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
          );
        }

        // Another reviewer exists: the screen names her, and the decision refuses the owner.
        const owner = caller('pair', 'owner');
        assert.deepEqual(await owner.catalogueSelfApproval(), {
          canSelfApprove: false,
          reviewers: ['Ayesha Khan'],
        });
        const edit = await owner.proposeCatalogueEdit({
          medicineId: id('med_pair'),
          changes: { productName: 'Owner lotion' },
        });
        assert.equal(
          (await owner.catalogueEdits()).find((row) => row.id === edit.id)?.ownEdit,
          true
        );
        await refusal(
          owner.decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE', soloPin: '2468' }),
          'FORBIDDEN'
        );
        const named = caller('pair', 'pharmacist');
        assert.equal(
          (await named.catalogueEdits()).find((row) => row.id === edit.id)?.ownEdit,
          false
        );
        assert.equal(
          (await named.decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' })).status,
          'APPROVED'
        );
        // A member without the review right, and a caller from another pharmacy, get nothing.
        await refusal(caller('pair', 'cashier').catalogueSelfApproval(), 'FORBIDDEN');
        const otherNames = await caller('other', 'pharmacist').catalogueSelfApproval();
        assert.deepEqual(otherNames, { canSelfApprove: false, reviewers: [] });

        // The owner alone: the screen offers the PIN, and the decision accepts it.
        const solo = caller('solo', 'owner');
        assert.deepEqual(await solo.catalogueSelfApproval(), {
          canSelfApprove: true,
          reviewers: [],
        });
        const soloEdit = await solo.proposeCatalogueEdit({
          medicineId: id('med_solo'),
          changes: { productName: 'Solo lotion' },
        });
        assert.equal(
          (
            await solo.decideCatalogueEdit({
              editId: soloEdit.id,
              decision: 'APPROVE',
              soloPin: '2468',
            })
          ).status,
          'APPROVED'
        );
        const audit = await createTenantDb(id('solo'), id('owner_solo')).auditLog.findFirstOrThrow({
          where: { targetId: soloEdit.id, action: 'pharmacy.catalogueSoloOwnerApproval' },
        });
        assert.deepEqual(audit.metadata, {
          soloOwner: true,
          pinVerified: true,
          reason: 'no other reviewer',
        });
      } finally {
        await c.end();
      }
    }, 60_000);
  }
);
