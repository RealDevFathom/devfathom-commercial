/**
 * PH-PUR / PUR-01, PUR-02, PUR-03 — the database half of the contract, against
 * migrated PostgreSQL with FORCED row-level security.
 *
 * The pure arithmetic and the router refusals are covered in `purchasing.test.ts`
 * and `src/server/routers/pharmacy-purchasing.test.ts`. What only a real database
 * can prove is here: that an unauthorized or licence-expired supplier is refused
 * by the table and not only by the router; that the purchase order status machine
 * cannot be skipped by a direct write; that licence evidence and approval events
 * are append-only; that canonical units cannot drift from the pack quantity they
 * project; and that a cross-tenant id substitution fails on the composite tenant
 * foreign key rather than merely being filtered out of a read.
 *
 * Every statement runs as the NOSUPERUSER/NOBYPASSRLS runtime role, so FORCE RLS
 * applies to this suite too. Skipped (never silently passed) when the database
 * URLs are absent.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUNTIME_DATABASE_URL =
  process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;

const describeIfDatabase = RUNTIME_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgA = `org_wha1166_a_${suffix}`;
const orgB = `org_wha1166_b_${suffix}`;

const TABLES = [
  'pharmacy_suppliers',
  'pharmacy_supplier_licences',
  'pharmacy_requisitions',
  'pharmacy_requisition_lines',
  'pharmacy_quotes',
  'pharmacy_quote_lines',
  'pharmacy_purchase_orders',
  'pharmacy_purchase_order_lines',
  'pharmacy_purchase_order_approvals',
] as const;

/** Ids seeded once in org A, reused across cases. */
const ids = {
  medicine: `med_${suffix}`,
  presentation: `pres_${suffix}`,
  packLevel: `pack_${suffix}`,
  supplierLicensed: `sup_ok_${suffix}`,
  supplierUnauthorized: `sup_unauth_${suffix}`,
  supplierLapsed: `sup_lapsed_${suffix}`,
  supplierB: `sup_b_${suffix}`,
  requisition: `req_${suffix}`,
  requisitionLine: `reql_${suffix}`,
  purchaseOrder: `po_${suffix}`,
  licence: `lic_${suffix}`,
  approval: `appr_${suffix}`,
};

let runtime: Client;

/** Run `work` inside a rolled-back transaction scoped to one tenant. */
async function inTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SET LOCAL app.current_organization_id = '${organizationId}'`);
    return await work();
  } finally {
    await runtime.query('ROLLBACK');
  }
}

/**
 * Assert that `run` fails with the given SQLSTATE — and, when `message` is given,
 * for that reason rather than an unrelated one — without poisoning the transaction.
 */
async function expectSqlState(code: string, run: () => Promise<unknown>, message?: string) {
  await runtime.query('SAVEPOINT expected_failure');
  try {
    await run();
    throw new Error(`Expected SQLSTATE ${code}, but the statement succeeded.`);
  } catch (error) {
    const received = error instanceof Error && 'code' in error ? String(error.code) : null;
    if (received !== code) throw error;
    if (message !== undefined) expect((error as Error).message).toContain(message);
  } finally {
    await runtime.query('ROLLBACK TO SAVEPOINT expected_failure');
    await runtime.query('RELEASE SAVEPOINT expected_failure');
  }
}

function insertPurchaseOrder(id: string, supplierId: string, status = 'DRAFT') {
  return runtime.query(
    `INSERT INTO "pharmacy_purchase_orders"
       ("id","organizationId","reference","status","supplierId","createdByUserId","updatedAt")
     VALUES ($1,$2,$1,$3::"PharmacyPurchaseOrderStatus",$4,'user_drafter',CURRENT_TIMESTAMP)`,
    [id, orgA, status, supplierId]
  );
}

beforeAll(async () => {
  if (!RUNTIME_DATABASE_URL || !OWNER_DATABASE_URL) return;
  // The runtime role must NOT be the owner, or FORCE RLS proves nothing here.
  expect(OWNER_DATABASE_URL).not.toBe(RUNTIME_DATABASE_URL);

  runtime = new Client({ connectionString: RUNTIME_DATABASE_URL });
  await runtime.connect();

  const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO "organizations"
        ("id","slug","legalName","displayName","status","deploymentMode","createdAt","updatedAt")
       VALUES ($1,$2,'PH-PUR A','PH-PUR A','ACTIVE','SHARED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
              ($3,$4,'PH-PUR B','PH-PUR B','ACTIVE','SHARED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [orgA, `wha1166-a-${suffix}`, orgB, `wha1166-b-${suffix}`]
    );

    // A medicine, presentation and pack level in org A: requisition and order
    // lines point at the PH-MED catalog.
    await owner.query(
      `INSERT INTO "pharmacy_medicines"
        ("id","organizationId","productName","productFamily","updatedAt")
       VALUES ($1,$2,'PH-PUR Medicine','PHARMACEUTICAL',CURRENT_TIMESTAMP)`,
      [ids.medicine, orgA]
    );
    await owner.query(
      `INSERT INTO "pharmacy_presentations"
        ("id","organizationId","medicineId","presentation","updatedAt")
       VALUES ($1,$2,$3,'Tablet',CURRENT_TIMESTAMP)`,
      [ids.presentation, orgA, ids.medicine]
    );
    await owner.query(
      `INSERT INTO "pharmacy_pack_levels"
        ("id","organizationId","presentationId","versionGroupId","version","level","unitsPerParent","effectiveFrom")
       VALUES ($1,$2,$3,'carton',1,'CARTON',10,CURRENT_TIMESTAMP)`,
      [ids.packLevel, orgA, ids.presentation]
    );

    // Three org-A suppliers: licensed and authorized, authorized but lapsed, and
    // fully licensed but not authorized. Plus one in org B for the cross-tenant case.
    for (const [id, organizationId, name, authorized] of [
      [ids.supplierLicensed, orgA, 'Licensed Distributors', true],
      [ids.supplierUnauthorized, orgA, 'Unauthorized Distributors', false],
      [ids.supplierLapsed, orgA, 'Lapsed Distributors', true],
      [ids.supplierB, orgB, 'Other Tenant Distributors', true],
    ] as const) {
      await owner.query(
        `INSERT INTO "pharmacy_suppliers" ("id","organizationId","name","authorized","updatedAt")
         VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)`,
        [id, organizationId, name, authorized]
      );
    }
    for (const [id, organizationId, supplierId, expiresAt, verified] of [
      [ids.licence, orgA, ids.supplierLicensed, "CURRENT_TIMESTAMP + interval '1 year'", true],
      [
        `${ids.licence}_u`,
        orgA,
        ids.supplierUnauthorized,
        "CURRENT_TIMESTAMP + interval '1 year'",
        true,
      ],
      [`${ids.licence}_l`, orgA, ids.supplierLapsed, "CURRENT_TIMESTAMP - interval '1 day'", true],
      [`${ids.licence}_b`, orgB, ids.supplierB, "CURRENT_TIMESTAMP + interval '1 year'", true],
    ] as const) {
      await owner.query(
        `INSERT INTO "pharmacy_supplier_licences"
          ("id","organizationId","supplierId","licenceType","licenceNumber","issuingAuthority",
           "issuedAt","expiresAt","verifiedAt")
         VALUES ($1,$2,$3,'DRUG_SALE','DSL-1','DRAP',
                 CURRENT_TIMESTAMP - interval '2 years', ${expiresAt}, ${verified ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
        [id, organizationId, supplierId]
      );
    }

    await owner.query(
      `INSERT INTO "pharmacy_requisitions"
        ("id","organizationId","reference","requestedByUserId","updatedAt")
       VALUES ($1,$2,$1,'user_requester',CURRENT_TIMESTAMP)`,
      [ids.requisition, orgA]
    );
    await owner.query(
      `INSERT INTO "pharmacy_requisition_lines"
        ("id","organizationId","requisitionId","lineNumber","medicineId","packLevelId",
         "quantityPacks","canonicalUnitsPerPack","canonicalUnits")
       VALUES ($1,$2,$3,1,$4,$5,10,10,100)`,
      [ids.requisitionLine, orgA, ids.requisition, ids.medicine, ids.packLevel]
    );
    await owner.query(
      `INSERT INTO "pharmacy_purchase_orders"
        ("id","organizationId","reference","supplierId","createdByUserId","updatedAt")
       VALUES ($1,$2,$1,$3,'user_drafter',CURRENT_TIMESTAMP)`,
      [ids.purchaseOrder, orgA, ids.supplierLicensed]
    );
    await owner.query(
      `INSERT INTO "pharmacy_purchase_order_approvals"
        ("id","organizationId","purchaseOrderId","actorUserId","policy","decision","fromStatus","toStatus")
       VALUES ($1,$2,$3,'user_approver','PUR-02:SEGREGATION_OF_DUTIES','REJECTED','SUBMITTED','DRAFT')`,
      [ids.approval, orgA, ids.purchaseOrder]
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  } finally {
    await owner.end();
  }
}, 60_000);

afterAll(async () => {
  // Every case runs inside a rolled-back transaction, so only the `beforeAll`
  // fixture survives — and its approval event and licence evidence are
  // append-only by design, which is one of the things this suite proves. The
  // fixture is namespaced by a random suffix so repeated runs never collide;
  // it is left in place rather than deleted through a back door.
  if (runtime) await runtime.end();
});

describeIfDatabase('PH-PUR row-level security', () => {
  it('enables and forces RLS with a tenant policy on every new table', async () => {
    const { rows } = await runtime.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p
                WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [[...TABLES]]
    );
    expect(rows).toHaveLength(TABLES.length);
    for (const row of rows) {
      expect({ table: row.relname, ...row }).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 1,
      });
    }
  });

  it('hides another tenant’s suppliers, requisitions and purchase orders', async () => {
    await inTenant(orgB, async () => {
      for (const [table, id] of [
        ['pharmacy_suppliers', ids.supplierLicensed],
        ['pharmacy_requisitions', ids.requisition],
        ['pharmacy_purchase_orders', ids.purchaseOrder],
      ] as const) {
        const { rowCount } = await runtime.query(`SELECT 1 FROM "${table}" WHERE "id" = $1`, [id]);
        expect({ table, rowCount }).toEqual({ table, rowCount: 0 });
      }
    });
  });

  it('refuses a cross-tenant supplier id on a purchase order', async () => {
    await inTenant(orgA, async () => {
      // Org B's supplier is authorized and holds a valid licence — only the
      // tenancy differs, and it is refused on exactly that ground.
      await expectSqlState(
        '23514',
        () => insertPurchaseOrder(`po_xtenant_${suffix}`, ids.supplierB),
        'supplier does not belong to this pharmacy'
      );
    });
  });

  it('refuses a quote line borrowed from another tenant’s requisition line', async () => {
    await inTenant(orgB, async () => {
      await runtime.query(
        `INSERT INTO "pharmacy_requisitions"
          ("id","organizationId","reference","requestedByUserId","updatedAt")
         VALUES ($1,$2,$1,'user_b',CURRENT_TIMESTAMP)`,
        [`req_b_${suffix}`, orgB]
      );
      await runtime.query(
        `INSERT INTO "pharmacy_quotes"
          ("id","organizationId","requisitionId","supplierId","quotedAt","validUntil")
         VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + interval '30 days')`,
        [`quote_b_${suffix}`, orgB, `req_b_${suffix}`, ids.supplierB]
      );
      await expectSqlState('23503', () =>
        runtime.query(
          `INSERT INTO "pharmacy_quote_lines"
            ("id","organizationId","quoteId","requisitionLineId","pricePerPackMinor","canonicalUnitsPerPack")
           VALUES ($1,$2,$3,$4,10000,10)`,
          [`ql_b_${suffix}`, orgB, `quote_b_${suffix}`, ids.requisitionLine]
        )
      );
    });
  });
});

describeIfDatabase('PUR-01 the database refuses an order to an unlicensed supplier', () => {
  it('refuses a purchase order for an unauthorized supplier', async () => {
    await inTenant(orgA, () =>
      expectSqlState(
        '23514',
        () => insertPurchaseOrder(`po_unauth_${suffix}`, ids.supplierUnauthorized),
        'supplier is not authorized to supply this pharmacy'
      )
    );
  });

  it('refuses a purchase order for a supplier whose licence has expired', async () => {
    await inTenant(orgA, () =>
      expectSqlState(
        '23514',
        () => insertPurchaseOrder(`po_lapsed_${suffix}`, ids.supplierLapsed),
        'supplier has no unexpired verified licence on file'
      )
    );
  });

  it('accepts a purchase order for an authorized, licensed supplier', async () => {
    await inTenant(orgA, async () => {
      const { rowCount } = await insertPurchaseOrder(`po_ok_${suffix}`, ids.supplierLicensed);
      expect(rowCount).toBe(1);
    });
  });

  it('refuses to move an order onto a supplier that has since lapsed', async () => {
    await inTenant(orgA, async () => {
      await insertPurchaseOrder(`po_move_${suffix}`, ids.supplierLicensed);
      await expectSqlState('23514', () =>
        runtime.query(`UPDATE "pharmacy_purchase_orders" SET "supplierId" = $1 WHERE "id" = $2`, [
          ids.supplierLapsed,
          `po_move_${suffix}`,
        ])
      );
    });
  });
});

describeIfDatabase('PUR-02 the status machine and the approval record', () => {
  it('refuses a direct write that skips approval on the way to SENT', async () => {
    await inTenant(orgA, async () => {
      await insertPurchaseOrder(`po_skip_${suffix}`, ids.supplierLicensed);
      await expectSqlState('23514', () =>
        runtime.query(`UPDATE "pharmacy_purchase_orders" SET "status" = 'SENT' WHERE "id" = $1`, [
          `po_skip_${suffix}`,
        ])
      );
    });
  });

  it('walks DRAFT → SUBMITTED → APPROVED → SENT when an approver is named', async () => {
    await inTenant(orgA, async () => {
      const id = `po_walk_${suffix}`;
      await insertPurchaseOrder(id, ids.supplierLicensed);
      await runtime.query(
        `UPDATE "pharmacy_purchase_orders" SET "status" = 'SUBMITTED' WHERE "id" = $1`,
        [id]
      );
      await runtime.query(
        `UPDATE "pharmacy_purchase_orders"
            SET "status" = 'APPROVED', "approvedAt" = CURRENT_TIMESTAMP, "approvedByUserId" = 'user_approver'
          WHERE "id" = $1`,
        [id]
      );
      const { rowCount } = await runtime.query(
        `UPDATE "pharmacy_purchase_orders" SET "status" = 'SENT', "sentAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [id]
      );
      expect(rowCount).toBe(1);
    });
  });

  it('refuses an APPROVED order that names no approver', async () => {
    await inTenant(orgA, async () => {
      const id = `po_noapprover_${suffix}`;
      await insertPurchaseOrder(id, ids.supplierLicensed, 'SUBMITTED');
      await expectSqlState('23514', () =>
        runtime.query(
          `UPDATE "pharmacy_purchase_orders" SET "status" = 'APPROVED' WHERE "id" = $1`,
          [id]
        )
      );
    });
  });

  it('refuses approval by the person who drafted the order', async () => {
    await inTenant(orgA, async () => {
      const id = `po_selfapprove_${suffix}`;
      await insertPurchaseOrder(id, ids.supplierLicensed, 'SUBMITTED');
      await expectSqlState('23514', () =>
        runtime.query(
          `UPDATE "pharmacy_purchase_orders"
              SET "status" = 'APPROVED', "approvedAt" = CURRENT_TIMESTAMP, "approvedByUserId" = 'user_drafter'
            WHERE "id" = $1`,
          [id]
        )
      );
    });
  });

  it('refuses approval of a requisition by its own requester', async () => {
    await inTenant(orgA, async () =>
      expectSqlState('23514', () =>
        runtime.query(
          `UPDATE "pharmacy_requisitions"
              SET "approvedAt" = CURRENT_TIMESTAMP, "approvedByUserId" = 'user_requester'
            WHERE "id" = $1`,
          [ids.requisition]
        )
      )
    );
  });

  it('keeps approval events append-only, so a refusal cannot be edited away', async () => {
    await inTenant(orgA, async () => {
      await expectSqlState('23514', () =>
        runtime.query(
          `UPDATE "pharmacy_purchase_order_approvals" SET "decision" = 'APPROVED' WHERE "id" = $1`,
          [ids.approval]
        )
      );
      await expectSqlState('23514', () =>
        runtime.query(`DELETE FROM "pharmacy_purchase_order_approvals" WHERE "id" = $1`, [
          ids.approval,
        ])
      );
    });
  });

  it('keeps licence evidence append-only, so an expiry cannot be moved', async () => {
    await inTenant(orgA, async () => {
      await expectSqlState('23514', () =>
        runtime.query(
          `UPDATE "pharmacy_supplier_licences" SET "expiresAt" = CURRENT_TIMESTAMP + interval '10 years' WHERE "id" = $1`,
          [ids.licence]
        )
      );
      await expectSqlState('23514', () =>
        runtime.query(`DELETE FROM "pharmacy_supplier_licences" WHERE "id" = $1`, [ids.licence])
      );
    });
  });
});

describeIfDatabase('PUR-02/PUR-03 quantity invariants', () => {
  it('refuses a requisition line whose canonical units do not project its packs', async () => {
    await inTenant(orgA, () =>
      expectSqlState('23514', () =>
        runtime.query(
          `INSERT INTO "pharmacy_requisition_lines"
            ("id","organizationId","requisitionId","lineNumber","medicineId","packLevelId",
             "quantityPacks","canonicalUnitsPerPack","canonicalUnits")
           VALUES ($1,$2,$3,2,$4,$5,10,10,999)`,
          [`reql_bad_${suffix}`, orgA, ids.requisition, ids.medicine, ids.packLevel]
        )
      )
    );
  });

  it('refuses an order line whose bonus canonical units do not project its bonus packs', async () => {
    await inTenant(orgA, async () => {
      const id = `po_bonus_${suffix}`;
      await insertPurchaseOrder(id, ids.supplierLicensed);
      await expectSqlState('23514', () =>
        runtime.query(
          `INSERT INTO "pharmacy_purchase_order_lines"
            ("id","organizationId","purchaseOrderId","lineNumber","medicineId","packLevelId",
             "orderedPacks","bonusPacks","canonicalUnitsPerPack","orderedCanonicalUnits",
             "bonusCanonicalUnits","listPricePerPackMinor")
           VALUES ($1,$2,$3,1,$4,$5,10,2,10,100,999,10000)`,
          [`pol_bad_${suffix}`, orgA, id, ids.medicine, ids.packLevel]
        )
      );
    });
  });

  it('accepts an order line whose bonus packs raise quantity at no cost', async () => {
    await inTenant(orgA, async () => {
      const id = `po_bonus_ok_${suffix}`;
      await insertPurchaseOrder(id, ids.supplierLicensed);
      await runtime.query(
        `INSERT INTO "pharmacy_purchase_order_lines"
          ("id","organizationId","purchaseOrderId","lineNumber","medicineId","packLevelId",
           "orderedPacks","bonusPacks","canonicalUnitsPerPack","orderedCanonicalUnits",
           "bonusCanonicalUnits","listPricePerPackMinor")
         VALUES ($1,$2,$3,1,$4,$5,10,2,10,100,20,10000)`,
        [`pol_ok_${suffix}`, orgA, id, ids.medicine, ids.packLevel]
      );
      const { rows } = await runtime.query<{ received: string; paid: string }>(
        `SELECT ("orderedCanonicalUnits" + "bonusCanonicalUnits")::text AS received,
                ("orderedPacks" * "listPricePerPackMinor")::text AS paid
           FROM "pharmacy_purchase_order_lines" WHERE "id" = $1`,
        [`pol_ok_${suffix}`]
      );
      // 120 units received for the price of 100 — the bonus is quantity, never money.
      expect(rows[0]).toEqual({ received: '120', paid: '100000' });
    });
  });
});
