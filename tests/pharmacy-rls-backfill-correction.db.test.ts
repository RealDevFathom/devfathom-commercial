// @vitest-environment node
/**
 * DEV-951: two backfills set only app.is_platform_admin and then read tables whose forced
 * row-level security admits only the tenant setting. Run by a NOSUPERUSER NOBYPASSRLS owner
 * (how deploy and the QA gate migrate) they matched nothing:
 *   20261116121200_pharmacy_voucher_controls      voucher usedCount from past redemptions
 *   20261110111300_pharmacy_receipt_print_cutover copyCount 1 for receipts issued before it
 * 20261118124400 and 20261118124500 repeat them one organization at a time. This suite seeds
 * two organizations, runs the original backfills and then the corrections, as the
 * non-superuser owner and (when given) as a superuser, for whom the originals worked and the
 * corrections must change nothing. Each run is one transaction that is rolled back.
 *
 * PHARMACY_TEST_OWNER_DATABASE_URL: the NOSUPERUSER NOBYPASSRLS role that owns the schema.
 * PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL: a superuser on the same database (optional).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDisposableRlsDatabase } from './disposable-rls-database';

const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const superuserUrl = process.env.PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL;

/** The migration body without its BEGIN/COMMIT: the suite owns the (rolled-back) transaction. */
function migration(name: string): string {
  return readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8')
    .replace(/^BEGIN;$/m, '')
    .replace(/^COMMIT;$/m, '');
}
const originalVoucherControls = migration('20261116121200_pharmacy_voucher_controls');
const originalReceiptCutover = migration('20261110111300_pharmacy_receipt_print_cutover');
const voucherCorrection = migration('20261118124400_pharmacy_voucher_use_count_correction');
const receiptCorrection = migration('20261118124500_pharmacy_receipt_print_state_correction');

type Voucher = {
  id: string;
  usedCount: number;
  maxUses: number;
  active: boolean;
  revokedAt: Date | null;
  validUntil: Date;
};
type PrintState = { saleId: string; copyCount: number };

/** One organization's fixture. Every id carries the organization prefix. */
function fixture(org: string) {
  const id = (key: string) => `${org}_${key}`;
  return {
    org,
    id,
    branch: id('branch'),
    // key: [maxUses, usedCount, redemptions on live sales, redemptions on voided sales, extra]
    vouchers: {
      usedOnce: [1, 0, 1, 0],
      overLimit: [1, 0, 2, 0],
      partlyCounted: [5, 1, 3, 0],
      countedAhead: [3, 3, 1, 0],
      voidedOnly: [1, 0, 0, 1],
      unused: [2, 0, 0, 0],
      revoked: [1, 0, 1, 0],
      expired: [1, 0, 1, 0],
    } as Record<string, [number, number, number, number]>,
  };
}

async function seed(client: pg.Client, f: ReturnType<typeof fixture>) {
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
  await q(`SELECT set_config('app.is_platform_admin','true',true)`);
  await q(
    `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt")
     VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',now(),now())`,
    [f.org]
  );
  await q(`SELECT set_config('app.current_organization_id',$1,true)`, [f.org]);
  await q(
    `INSERT INTO pharmacy_branches(id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
     VALUES ($1,$2,$1,'QA','QA','Lahore','PB',now())`,
    [f.branch, f.org]
  );
  await q(
    `INSERT INTO pharmacy_medicines(id,"organizationId","productName","productFamily","updatedAt")
     VALUES ($1,$2,'Front shop item','FRONT_SHOP',now())`,
    [f.id('medicine'), f.org]
  );
  await q(
    `INSERT INTO pharmacy_presentations(id,"organizationId","medicineId",presentation,"updatedAt")
     VALUES ($1,$2,$3,'Unit',now())`,
    [f.id('presentation'), f.org, f.id('medicine')]
  );
  await q(
    `INSERT INTO pharmacy_pack_levels(id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom")
     VALUES ($1,$2,$3,$1,1,'UNIT',1,'2020-01-01')`,
    [f.id('pack'), f.org, f.id('presentation')]
  );

  let receipt = 0;
  /** A sale with the given voucher lines, completed (numbered receipt) or voided. */
  async function sale(key: string, status: 'COMPLETED' | 'VOID' | 'OPEN', voucherIds: string[]) {
    const saleId = f.id(`sale_${key}`);
    await q(
      `INSERT INTO pharmacy_sales(id,"organizationId","branchId",status,"createdByUserId","updatedAt")
       VALUES ($1,$2,$3,'OPEN','owner',now())`,
      [saleId, f.org, f.branch]
    );
    for (const [index, voucherId] of voucherIds.entries()) {
      await q(
        `INSERT INTO pharmacy_sale_lines(id,"organizationId","branchId","saleId","medicineId","presentationId","packLevelId",
           "saleUnit",quantity,"canonicalUnitsPerSaleUnit","canonicalUnits","unitPriceMinor","grossMinor","proRataCeilingMinor",
           "unitCostMinor","idempotencyKey","discountKind","discountMinor","voucherId","approvalPolicy","approvedByUserId")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'UNIT',1,1,1,500,500,500,100,$1,'VOUCHER',100,$8,'VOUCHER_WITHIN_CAP','owner')`,
        [
          `${saleId}_line${index}`,
          f.org,
          f.branch,
          saleId,
          f.id('medicine'),
          f.id('presentation'),
          f.id('pack'),
          voucherId,
        ]
      );
    }
    if (status === 'COMPLETED') {
      receipt += 1;
      await q(
        `UPDATE pharmacy_sales SET status='COMPLETED',"receiptNumber"=$2,"receiptDeviceId"='device',
           "businessDate"='2026-10-01',"completedAt"='2026-10-01T08:00:00Z' WHERE id=$1`,
        [saleId, receipt]
      );
    } else if (status === 'VOID') {
      await q(`UPDATE pharmacy_sales SET status='VOID' WHERE id=$1`, [saleId]);
    }
    return saleId;
  }

  for (const [key, [maxUses, usedCount, live, voided]] of Object.entries(f.vouchers)) {
    const voucherId = f.id(`voucher_${key}`);
    await q(
      `INSERT INTO pharmacy_vouchers(id,"organizationId","branchId",code,name,body,"discountMinor","validUntil",
         "issuedByUserId","approvedByUserId","approvalPolicy","maxUses")
       VALUES ($1,$2,$3,$1,'Offer','Rs 1 off selected items.',100,$4,'owner','owner','VOUCHER_WITHIN_CAP',$5)`,
      [voucherId, f.org, f.branch, key === 'expired' ? '2026-10-15' : '2031-01-01', maxUses]
    );
    for (let use = 0; use < live; use += 1) await sale(`${key}_${use}`, 'COMPLETED', [voucherId]);
    for (let use = 0; use < voided; use += 1) await sale(`${key}_void_${use}`, 'VOID', [voucherId]);
    // The count the counter kept (0 before DEV-819; later uses counted at the counter).
    await q(`UPDATE pharmacy_vouchers SET "usedCount"=$2 WHERE id=$1`, [voucherId, usedCount]);
    if (key === 'revoked')
      await q(
        `UPDATE pharmacy_vouchers SET active=false,"revokedAt"='2026-11-01',"revokeReason"='Withdrawn' WHERE id=$1`,
        [voucherId]
      );
  }

  // Receipts. Issuance after the cutover gets copyCount 0 from the issue trigger; the
  // legacy ones lose it again, as receipts issued before the cutover never had one.
  const legacy = [await sale('legacy_1', 'COMPLETED', []), await sale('legacy_2', 'COMPLETED', [])];
  const issuedAfterCutover = await sale('issued_after', 'COMPLETED', []);
  const printedAfterCutover = await sale('printed_after', 'COMPLETED', []);
  const open = await sale('open', 'OPEN', []);
  await q(`DELETE FROM pharmacy_receipt_print_states WHERE "saleId" = ANY($1)`, [
    [...legacy, printedAfterCutover],
  ]);
  // A legacy receipt first printed after the cutover: the runtime recorded copy 2.
  await q(
    `INSERT INTO pharmacy_receipt_print_states(id,"organizationId","branchId","saleId","copyCount","updatedAt")
     VALUES ($1,$2,$3,$4,2,now())`,
    [randomUUID(), f.org, f.branch, printedAfterCutover]
  );
  await q(`SELECT set_config('app.current_organization_id','',true)`);
  await q(`SELECT set_config('app.is_platform_admin','',true)`);
  return { legacy, issuedAfterCutover, printedAfterCutover, open };
}

async function read(client: pg.Client, org: string) {
  await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [org]);
  const vouchers = await client.query<Voucher>(
    `SELECT id,"usedCount","maxUses",active,"revokedAt","validUntil" FROM pharmacy_vouchers WHERE "organizationId"=$1 ORDER BY id`,
    [org]
  );
  const states = await client.query<PrintState>(
    `SELECT "saleId","copyCount" FROM pharmacy_receipt_print_states WHERE "organizationId"=$1 ORDER BY "saleId"`,
    [org]
  );
  const allStates = await client.query(
    `SELECT * FROM pharmacy_receipt_print_states WHERE "organizationId"=$1 ORDER BY id`,
    [org]
  );
  await client.query(`SELECT set_config('app.current_organization_id','',true)`);
  return {
    vouchers: Object.fromEntries(vouchers.rows.map((v) => [v.id.slice(org.length + 9), v])),
    states: Object.fromEntries(states.rows.map((s) => [s.saleId, s.copyCount])),
    rawStates: allStates.rows,
  };
}

function suite(label: string, url: string | undefined, superuser: boolean) {
  (url ? describe : describe.skip)(label, () => {
    const client = new pg.Client({ connectionString: url });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const a = fixture(`dev951a_${suffix}`);
    const b = fixture(`dev951b_${suffix}`);
    let receiptsA: Awaited<ReturnType<typeof seed>>;
    let receiptsB: Awaited<ReturnType<typeof seed>>;
    let afterOriginal: { a: Awaited<ReturnType<typeof read>>; b: Awaited<ReturnType<typeof read>> };
    let tenantAfterCorrections: string | null;

    beforeAll(async () => {
      assertDisposableRlsDatabase(url!);
      await client.connect();
      const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      // The point of each run: what role the migrations run as.
      expect(role.rows[0]).toEqual({ rolsuper: superuser, rolbypassrls: superuser });
      await client.query('BEGIN');
      receiptsA = await seed(client, a);
      receiptsB = await seed(client, b);
      // The original migrations, exactly as deploy ran them, with no setting of our own.
      await client.query(originalVoucherControls);
      await client.query(originalReceiptCutover);
      afterOriginal = { a: await read(client, a.org), b: await read(client, b.org) };
      await client.query(voucherCorrection);
      await client.query(receiptCorrection);
      tenantAfterCorrections = (
        await client.query<{ org: string | null }>(
          `SELECT current_setting('app.current_organization_id', true) AS org`
        )
      ).rows[0]!.org;
    }, 120_000);

    afterAll(async () => {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    });

    if (!superuser) {
      it('reproduces the fault: the original backfills see no sales as a non-superuser owner', () => {
        for (const side of [afterOriginal.a, afterOriginal.b]) {
          expect(side.vouchers.usedOnce).toMatchObject({ usedCount: 0, maxUses: 1 });
          expect(side.vouchers.overLimit).toMatchObject({ usedCount: 0, maxUses: 1 });
        }
        for (const saleId of [...receiptsA.legacy, ...receiptsB.legacy])
          expect(afterOriginal.a.states[saleId] ?? afterOriginal.b.states[saleId]).toBeUndefined();
      });

      it('counts each voucher’s past redemptions in both organizations, never lowering a count', async () => {
        for (const f of [a, b]) {
          const { vouchers } = await read(client, f.org);
          const counts = Object.fromEntries(
            Object.entries(vouchers).map(([key, v]) => [key, [v.usedCount, v.maxUses]])
          );
          expect(counts).toEqual({
            usedOnce: [1, 1], // used up: the counter now refuses it
            overLimit: [2, 2], // redeemed twice before the limit existed: used up, not lowered
            partlyCounted: [3, 5], // two uses genuinely left
            countedAhead: [3, 3], // never lowered to the line count
            voidedOnly: [0, 1], // a void gives its use back
            unused: [0, 2],
            revoked: [1, 1],
            expired: [1, 1],
          });
          // Revocation and expiry are left exactly as they were.
          const before = f === a ? afterOriginal.a.vouchers : afterOriginal.b.vouchers;
          for (const key of Object.keys(f.vouchers)) {
            const { active, revokedAt, validUntil } = vouchers[key]!;
            expect({ active, revokedAt, validUntil }).toEqual({
              active: before[key]!.active,
              revokedAt: before[key]!.revokedAt,
              validUntil: before[key]!.validUntil,
            });
          }
          expect(vouchers.revoked).toMatchObject({ active: false });
          expect(vouchers.revoked!.revokedAt).not.toBeNull();
          expect(vouchers.usedOnce).toMatchObject({ active: true, revokedAt: null });
        }
      });

      it('gives receipts issued before the cutover their print state, leaving every other state alone', async () => {
        for (const [f, r] of [
          [a, receiptsA],
          [b, receiptsB],
        ] as const) {
          const { states } = await read(client, f.org);
          expect(states[r.legacy[0]!]).toBe(1);
          expect(states[r.legacy[1]!]).toBe(1);
          expect(states[r.issuedAfterCutover]).toBe(0); // its original is still to be printed
          expect(states[r.printedAfterCutover]).toBe(2); // first printed after the cutover
          expect(states[r.open]).toBeUndefined(); // no receipt issued
        }
      });
    }

    if (superuser) {
      it('the original backfills worked for a superuser', () => {
        expect(afterOriginal.a.vouchers.usedOnce).toMatchObject({ usedCount: 1, maxUses: 1 });
        expect(afterOriginal.b.vouchers.overLimit).toMatchObject({ usedCount: 2, maxUses: 2 });
        expect(afterOriginal.a.states[receiptsA.legacy[0]!]).toBe(1);
        expect(afterOriginal.b.states[receiptsB.legacy[1]!]).toBe(1);
      });

      it('the corrections then change nothing', async () => {
        expect({ a: await read(client, a.org), b: await read(client, b.org) }).toEqual(
          afterOriginal
        );
      });
    }

    it('is idempotent: running the corrections again changes nothing', async () => {
      const before = { a: await read(client, a.org), b: await read(client, b.org) };
      await client.query(voucherCorrection);
      await client.query(receiptCorrection);
      expect({ a: await read(client, a.org), b: await read(client, b.org) }).toEqual(before);
    });

    it('leaves no tenant set behind', () => {
      expect(tenantAfterCorrections ?? '').toBe('');
    });
  });
}

suite('DEV-951 backfill corrections, migrated by a NOSUPERUSER NOBYPASSRLS owner', ownerUrl, false);
suite(
  'DEV-951 backfill corrections, where a superuser ran the original backfills',
  superuserUrl,
  true
);
