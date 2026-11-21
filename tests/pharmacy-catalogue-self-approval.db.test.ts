import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
import type { TRPCContext } from '@/server/trpc';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? '';
const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
// Only unrelated automatic request logging is suppressed; approval audits are real writes.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

/** DEV-961: an independent RFC 6238 oracle (SHA-1, 6 digits, 30 s). */
function codeAt(secretB32: string, at: Date): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const value = hmac.readUInt32BE(hmac[hmac.length - 1] & 0xf) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

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
          // DEV-961: these approvals use a fixed PIN, which applies while the owner has the
          // authenticator for approvals turned off; the next case approves with the app code.
          await c.query(
            `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","requireApprovalAuthenticator","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',false,now(),now())`,
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

    it('DEV-961: with the authenticator on, the solo owner approves with the app code, not the PIN', async () => {
      assertDisposableRlsDatabase(ownerUrl);
      assertDisposableRlsDatabase(runtimeUrl);
      const { pharmacyMedicineRouter } = await import('@/server/routers/pharmacy-medicine');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
      const { encryptSecret } = await import('@/lib/secret-crypto');
      const { generateTotpSecret } = await import('@/lib/totp');

      const c = new pg.Client({ connectionString: ownerUrl });
      await c.connect();
      try {
        const prefix = 'selfcode_' + randomUUID().slice(0, 8);
        const id = (x: string) => prefix + '_' + x;
        const secret = generateTotpSecret();
        await c.query("SELECT set_config('app.is_platform_admin','true',false)");
        // The organization keeps the default: the authenticator for approvals is on.
        await c.query(
          `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
          [id('org')]
        );
        await c.query(
          `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
          [id('dep'), id('org')]
        );
        await c.query(
          `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'owner','Owner',true,now())`,
          [id('ownerrole'), id('org')]
        );
        await c.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'*','ALLOW')`,
          [id('perm'), id('org'), id('ownerrole')]
        );
        await c.query(
          `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,status,"updatedAt") VALUES ($1,$2,$3,'Solo Owner',$1,'Pharmacy','Staff','ADMIN','ACTIVE',now())`,
          [id('owner'), id('org'), id('ownerrole')]
        );
        await c.query(
          `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW','fixture',now())`,
          [id('review'), id('org'), id('owner')]
        );
        // The PIN credential still names the approver and carries the lockout.
        await c.query(
          `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,'Fixture owner','ACTIVE',now())`,
          [id('staff'), id('org'), id('owner')]
        );
        await c.query(
          `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
          [id('credential'), id('org'), id('staff'), await hashOperatorCredential('PIN', '2468')]
        );
        await c.query(
          `INSERT INTO approval_authenticators (id,"organizationId","userId","encryptedSecret","enabledAt","updatedAt") VALUES ($1,$2,$3,$4,now(),now())`,
          [id('authenticator'), id('org'), id('owner'), encryptSecret(secret)]
        );
        await c.query(
          `INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily",saleable,"updatedAt") VALUES ($1,$2,'Fixture lotion','FRONT_SHOP',true,now())`,
          [id('med'), id('org')]
        );
        const owner = pharmacyMedicineRouter.createCaller({
          db: createTenantDb(id('org'), id('owner')),
          entitlements: {
            organizationId: id('org'),
            enabledModules: ['pharmacy-core'],
            activeSeats: 1,
            seatLimit: 10,
            modules: [],
            limits: {},
          },
          session: {
            expires: 'later',
            user: { id: id('owner'), organizationId: id('org'), role: 'ADMIN', status: 'ACTIVE' },
          },
          organization: null,
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as unknown as TRPCContext);

        const edit = await owner.proposeCatalogueEdit({
          medicineId: id('med'),
          changes: { productName: 'Code lotion' },
        });
        // The permanent PIN is refused, worded for the app code; nothing is published.
        await assert.rejects(
          owner.decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE', soloPin: '2468' }),
          (error: unknown) =>
            error instanceof Error &&
            error.message ===
              'That approval code is not right or was already used. Enter the current code from your authenticator app.'
        );
        const [medicine] = (
          await c.query(`SELECT "productName" FROM pharmacy_medicines WHERE id=$1`, [id('med')])
        ).rows;
        assert.equal(medicine.productName, 'Fixture lotion');

        // The current code from the owner's app approves it, through the shared verifier.
        assert.equal(
          (
            await owner.decideCatalogueEdit({
              editId: edit.id,
              decision: 'APPROVE',
              soloPin: codeAt(secret, new Date()),
            })
          ).status,
          'APPROVED'
        );
        const [approval] = (
          await c.query(
            `SELECT metadata->>'approvalMethod' AS method, metadata->>'approverRight' AS "right" FROM audit_logs WHERE "organizationId"=$1 AND "actorId"=$2 AND source='AUTH' ORDER BY "createdAt" DESC LIMIT 1`,
            [id('org'), id('owner')]
          )
        ).rows;
        assert.deepEqual(approval, { method: 'AUTHENTICATOR', right: 'OWNER' });
      } finally {
        await c.end();
      }
    }, 60_000);
  }
);
