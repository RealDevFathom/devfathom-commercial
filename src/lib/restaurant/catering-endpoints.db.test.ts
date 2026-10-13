/** Calls actual route functions and tRPC middleware against the restricted disposable DB. */
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { withPlatformDb, withTenantDb, createTenantDb } from '@/lib/tenancy/scoped-db';
import { enrollDevice } from './devices';
import { establishSession, bindOperator } from './terminal-session';
import { POST } from '@/app/api/restaurant/catering/money/route';
import { restaurantCateringRouter } from '@/server/routers/restaurant-catering';
import { router, type TRPCContext } from '@/server/trpc';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';
import { payloadHash } from './catering-operations';
import { can, subjectFromSession } from '@/lib/abac';
import {
  assertAcceptanceDatabase,
  readAcceptanceReceipt,
} from '../../../scripts/restaurant-acceptance-target';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const org = `catering_endpoint_${randomUUID()}`,
  branch = randomUUID(),
  otherBranch = randomUUID(),
  user = randomUUID(),
  staff = randomUUID(),
  order = randomUUID(),
  quote = randomUUID();
let secret: string, token: string, sessionId: string, deviceId: string, coreModule: string;
const tenant = <T>(fn: Parameters<typeof withTenantDb<T>>[1]) => withTenantDb(org, fn);
const body = {
  cateringOrderId: order,
  quoteRevisionId: quote,
  kind: 'DEPOSIT',
  amount: '30.00',
  currency: 'PKR',
  source: 'OPERATOR_ATTESTED',
  externalEvidenceSource: 'synthetic',
  externalEvidenceReference: randomUUID(),
};
function request(data: object = body, key = randomUUID(), bearer = secret, session = token) {
  return new Request('http://localhost/api/restaurant/catering/money', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      'x-terminal-session': session,
      'idempotency-key': key,
    },
    body: JSON.stringify(data),
  });
}
async function caller() {
  const db = createTenantDb(org, user);
  return router({ restaurantCatering: restaurantCateringRouter }).createCaller({
    db,
    entitlements: await resolveOrganizationEntitlements(org, db),
    session: {
      expires: 'later',
      user: {
        id: user,
        organizationId: org,
        role: 'EMPLOYEE',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).restaurantCatering;
}
describe('catering authenticated endpoints', () => {
  beforeAll(async () => {
    if (process.env.RESTAURANT_ACCEPTANCE_ADMITTED === '1') {
      assertAcceptanceDatabase(url, readAcceptanceReceipt());
    } else if (!url || new URL(url).port !== '55675') {
      throw new Error('Exclusive disposable DB required');
    }
    await withPlatformDb(async (tx) => {
      const role =
        await tx.$queryRaw`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`;
      expect(role).toEqual([
        { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false },
      ]);
      await tx.organization.create({
        data: {
          id: org,
          slug: org,
          legalName: 'Synthetic endpoint',
          displayName: 'Synthetic endpoint',
          status: 'ACTIVE',
        },
      });
      for (const key of ['restaurant-core', 'restaurant-pos']) {
        const platformModule = await tx.platformModule.upsert({
          where: { key },
          create: {
            key,
            name: key,
            category: 'restaurant',
            band: key === 'restaurant-core' ? 'VERTICAL_CORE' : 'VERTICAL_OPTIONAL',
            vertical: 'RESTAURANT',
          },
          update: {},
        });
        if (key === 'restaurant-core') coreModule = platformModule.id;
        await tx.organizationModule.create({
          data: { organizationId: org, moduleId: platformModule.id, status: 'ENABLED' },
        });
      }
      const catalog =
        await tx.$queryRaw`SELECT c.conrelid::regclass::text AS tab,c.conname::text AS conname,c.contype::text AS contype,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,pos) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS fields,
    c.confrelid::regclass::text AS target,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,pos) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.pos) AS refs,
    c.confdeltype::text AS confdeltype,c.confupdtype::text AS confupdtype,pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c WHERE c.conrelid::regclass::text LIKE 'restaurant_catering_%' ORDER BY 1,2`;
      const receipt = process.env.RESTAURANT_ACCEPTANCE_RUNTIME_RECEIPT;
      writeFileSync(
        process.env.RESTAURANT_ACCEPTANCE_ADMITTED === '1' && receipt
          ? new URL('./catering-catalog.json', `file://${receipt}`)
          : '../runtime-evidence/catering-catalog.json',
        JSON.stringify(catalog, null, 2)
      );
    });
    await tenant(async (tx) => {
      for (const b of [branch, otherBranch])
        await tx.restaurantBranch.create({
          data: { id: b, name: 'Synthetic branch', timezone: 'UTC', businessDayCutoff: '00:00' },
        });
      await tx.organizationDepartment.create({
        data: { key: 'OPERATIONS', name: 'Operations' },
      });
      await tx.user.create({
        data: {
          id: user,
          name: 'Synthetic operator',
          email: `${user}@example.invalid`,
          department: 'OPERATIONS',
          title: 'Operator',
        },
      });
      await tx.restaurantStaffProfile.create({
        data: {
          id: staff,
          userId: user,
          primaryBranchId: branch,
          displayName: 'Synthetic operator',
        },
      });
      for (const capability of ['catering:read', 'catering:manage']) {
        await tx.restaurantStaffCapabilityGrant.create({
          data: { staffProfileId: staff, branchId: branch, capability, effect: 'ALLOW' },
        });
        await tx.userPermissionOverride.create({
          data: { userId: user, capability, effect: 'ALLOW', reason: 'Synthetic acceptance' },
        });
      }
      const enrolled = await enrollDevice(tx, { branchId: branch, name: 'Synthetic terminal' });
      secret = enrolled.secret;
      deviceId = enrolled.device.id;
      const established = await establishSession(tx, deviceId, new Date());
      token = established.token;
      sessionId = established.session.id;
      await bindOperator(tx, sessionId, staff, new Date());
      await tx.restaurantCateringOrder.create({
        data: {
          id: order,
          branchId: branch,
          eventName: 'Endpoint proof',
          eventDate: new Date(),
          headcount: 1,
          quotedTotal: '100',
          depositAmount: '70',
        },
      });
      const snapshot = { schemaVersion: 1, currency: 'PKR', quotedTotal: '100' };
      await tx.restaurantCateringQuoteRevision.create({
        data: {
          id: quote,
          orderId: order,
          revision: 0,
          snapshot,
          contentHash: payloadHash(snapshot),
          createdByStaffId: staff,
        },
      });
      await tx.restaurantCateringQuoteApproval.create({
        data: {
          id: randomUUID(),
          orderId: order,
          quoteRevisionId: quote,
          orderRevision: 0,
          actorStaffProfileId: staff,
        },
      });
      await tx.restaurantCateringOrder.update({
        where: { id: order },
        data: { approvedQuoteRevisionId: quote },
      });
    });
  });
  it('booking locations work for catering-only staff without inventory reports and deny cross-branch access', async () => {
    const active = randomUUID();
    await tenant(async (tx) => {
      await tx.restaurantStockLocation.createMany({
        data: [
          { id: active, branchId: branch, name: 'Booking kitchen', isActive: true },
          { branchId: branch, name: 'Closed kitchen', isActive: false },
          { branchId: otherBranch, name: 'Other kitchen', isActive: true },
        ],
      });
      const subject = subjectFromSession({ id: user, role: 'EMPLOYEE', status: 'ACTIVE' });
      expect(await can(subject, 'inventory:read', undefined, { db: tx })).toBe(false);
      expect(await can(subject, 'reports:operational', undefined, { db: tx })).toBe(false);
    });
    const client = await caller();
    expect(await client.bookingLocations({ branchId: branch })).toEqual([
      { id: active, name: 'Booking kitchen' },
    ]);
    await expect(client.bookingLocations({ branchId: otherBranch })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('records authenticated evidence once and summarizes real receipts separately from planned deposit', async () => {
    const key = randomUUID();
    const a = await POST(request(body, key));
    expect(a.status).toBe(200);
    const result = await a.json();
    expect(result.replayed).toBe(false);
    const b = await POST(request(body, key));
    expect(b.status).toBe(200);
    expect(await b.json()).toMatchObject({ evidenceId: result.evidenceId, replayed: true });
    const summary = await (await caller()).paymentSummary({ orderId: order });
    expect(summary.evidence).toEqual([
      expect.objectContaining({ id: result.evidenceId, quoteRevisionId: quote, amount: '30.00' }),
    ]);
    expect(await (await caller()).approvalHistory({ orderId: order })).toEqual([
      expect.objectContaining({
        quoteRevisionId: quote,
        actorStaffProfileId: staff,
        orderRevision: 0,
      }),
    ]);
    expect(await (await caller()).consumptionHistory({ orderId: order })).toEqual({
      reconciliationRequired: false,
      movements: [],
    });
    expect(summary).toMatchObject({
      approvedQuoteTotal: '100',
      plannedDepositAmount: '70',
      recordedReceipts: '30.00',
      netPaid: '30.00',
      amountDue: '70.00',
      currency: 'PKR',
      moneyBasis: 'UNEARNED_EVIDENCE',
    });
  });
  it('rejects forged actor input, invalid device/session, branch and capability abuse without evidence writes', async () => {
    const before = await tenant((tx) => tx.cateringMoneyEvidence.count());
    expect((await POST(request({ ...body, actorStaffProfileId: randomUUID() }))).status).toBe(400);
    expect((await POST(request(body, randomUUID(), 'rdk_invalid'))).status).toBe(401);
    expect((await POST(request(body, randomUUID(), secret, 'rts_invalid'))).status).toBe(401);
    const other = await tenant(async (tx) => {
      const enrolled = await enrollDevice(tx, {
        branchId: otherBranch,
        name: 'Other branch terminal',
      });
      const established = await establishSession(tx, enrolled.device.id, new Date());
      await bindOperator(tx, established.session.id, staff, new Date());
      return { secret: enrolled.secret, token: established.token };
    });
    expect((await POST(request(body, randomUUID(), other.secret, other.token))).status).toBe(403);
    await tenant((tx) =>
      tx.restaurantStaffCapabilityGrant.updateMany({
        where: { staffProfileId: staff, capability: 'catering:manage' },
        data: { effect: 'DENY' },
      })
    );
    expect((await POST(request())).status).toBe(403);
    await tenant((tx) =>
      tx.restaurantStaffCapabilityGrant.updateMany({
        where: { staffProfileId: staff, capability: 'catering:manage' },
        data: { effect: 'ALLOW' },
      })
    );
    expect(await tenant((tx) => tx.cateringMoneyEvidence.count())).toBe(before);
  });
  it('rejects disabled core package through actual terminal and tRPC guards', async () => {
    await withPlatformDb((tx) =>
      tx.organizationModule.updateMany({
        where: { organizationId: org, moduleId: coreModule },
        data: { status: 'DISABLED' },
      })
    );
    expect((await POST(request())).status).toBe(403);
    await expect((await caller()).paymentSummary({ orderId: order })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await withPlatformDb((tx) =>
      tx.organizationModule.updateMany({
        where: { organizationId: org, moduleId: coreModule },
        data: { status: 'ENABLED' },
      })
    );
  });
  it('maps a rejected overpayment after transaction rollback, preserving evidence and idempotency', async () => {
    const before = await tenant(async (tx) => ({
      evidence: await tx.cateringMoneyEvidence.count(),
      keys: await tx.restaurantMoneyIdempotencyKey.count(),
    }));
    const response = await POST(
      request({ ...body, amount: '100.00', externalEvidenceReference: randomUUID() })
    );
    expect(response.status).toBe(409);
    expect(
      await tenant(async (tx) => ({
        evidence: await tx.cateringMoneyEvidence.count(),
        keys: await tx.restaurantMoneyIdempotencyKey.count(),
      }))
    ).toEqual(before);
  });
});
