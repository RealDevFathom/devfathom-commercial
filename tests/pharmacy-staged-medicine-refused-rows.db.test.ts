/**
 * DEV-1002: the owner's file of 18,933 medicines stopped at 18,000 created with "Nothing was
 * changed. Try again." on every press: one row the database refused took the last group of
 * 933 rows down with it. Under a restricted PostgreSQL runtime role with forced row-level
 * security, the last group here holds the rows found to refuse a whole group (an old code or
 * generic name with no letter or digit, characters the database normalises differently, a name
 * cut inside an emoji) and one row the database refuses outright. Every valid row is created,
 * the refused row is recorded with a plain reason, nothing already created changes, and
 * pressing Create medicines again finishes with nothing made twice.
 * Skipped (never silently passed) without the database URLs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
import type { TRPCContext } from '@/server/trpc';

const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? '';
const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
// Automatic request logging is captured, not written, to keep the fixture bounded; the test
// reads the audit detail each creation step hands to it.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const ROWS = 18_933;
const HEADER =
  'Name,aliasname,PackUnits,saleprice,purprice,QTY,classname,Generic Name,Pack Type,Barcode';
const FIRST_BARCODE = '0896000000031';
const LONG_NAME = 'L'.repeat(299) + '\u{1F600}' + ' tail';
const REFUSED = 'Fixture Refused By Database';

/**
 * The owner's shape: 18,933 named rows, created 1,000 at a time; the awkward rows sit in the
 * last group (rows 18,001 to 18,933).
 */
function ownerFile() {
  const lines = [HEADER, `Fixture First Item,F-1,10,50.00,40.00,1,TABLETS,,,${FIRST_BARCODE}`];
  for (let n = 2; n <= 18_010; n += 1)
    lines.push(`Fixture Bulk Item ${n},B${n},10,50.00,40.00,${n % 7},GENERAL,,,`);
  lines.push(
    // An old code with no letter or digit: on develop the alias check refused the whole group.
    'Fixture Dash Code,-,10,30.00,20.00,1,TABLETS,-,,',
    // Characters the application and the database normalise differently.
    'Fixture Cobalamin Tab,X²,10,30.00,20.00,1,TABLETS,Cyanocobalamin B₁₂,,',
    // An old code and a generic name the database normalises to nothing: left off, reported.
    'Fixture Unsearchable Codes,①,10,30.00,20.00,1,TABLETS,½,,',
    'Fixture Fraction Barcode,FB-1,10,30.00,20.00,1,TABLETS,,,AB½12',
    // A name over 300 characters whose cut falls inside an emoji.
    `${LONG_NAME},LN-1,10,30.00,20.00,1,TABLETS,,,`,
    // The same barcode as row 1, created 18 groups earlier: reported, never moved.
    `Fixture Repeat Barcode,RB-1,10,30.00,20.00,1,TABLETS,,,${FIRST_BARCODE}`,
    // A repeat of an earlier row of this file, and a NARCOTICS-class row.
    'Fixture Bulk Item 2,B2,10,50.00,40.00,2,GENERAL,,,',
    'Fixture Last Opioid 5mg,OP-1,10,90.00,70.00,1,NARCOTICS,,,',
    // A row the database refuses outright (a fixture constraint below stands in for any refusal).
    `${REFUSED},RF-1,10,30.00,20.00,1,TABLETS,,,`,
    'Fixture Zero Pack,ZP-1,0,30.00,20.00,1,TABLETS,,,'
  );
  for (let n = lines.length; n <= ROWS; n += 1)
    lines.push(`Fixture Tail Item ${n},T${n},10,50.00,40.00,1,GENERAL,,,`);
  return lines.join('\n') + '\n';
}

(ownerUrl && runtimeUrl ? describe : describe.skip)(
  'DEV-1002 one refused row never stops a staged medicine file',
  () => {
    it(
      'creates every valid row of the last group, records the refused row and finishes once',
      { timeout: 1_800_000 },
      async () => {
        assertDisposableRlsDatabase(ownerUrl);
        assertDisposableRlsDatabase(runtimeUrl);
        const { pharmacyMedicineRouter } = await import('@/server/routers/pharmacy-medicine');
        const { pharmacyStagedReviewRouter } =
          await import('@/server/routers/pharmacy-staged-review');
        const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
        const { recordTrpcAudit } = await import('@/server/audit');

        const c = new pg.Client({ connectionString: ownerUrl });
        await c.connect();
        const prefix = 'dv1002_' + randomUUID().slice(0, 8);
        const id = (x: string) => prefix + '_' + x;
        const constraint = `${prefix}_refusal`;
        try {
          await c.query("SELECT set_config('app.is_platform_admin','true',false)");
          await c.query(
            `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
            [id('org')]
          );
          await c.query(
            `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
            [id('dep'), id('org')]
          );
          await c.query(
            `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,'MAIN','Main','Fixture street','Lahore','PB',now())`,
            [id('branch'), id('org')]
          );
          for (const who of ['editor', 'reviewer', 'cashier'])
            await c.query(
              `INSERT INTO users (id,"organizationId",name,email,department,title,role,"updatedAt") VALUES ($1,$2,$1,$1,'Pharmacy','Staff',$3,now())`,
              [id(who), id('org'), who === 'cashier' ? 'EMPLOYEE' : 'ADMIN']
            );
          await c.query(
            `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW','fixture',now())`,
            [id('review'), id('org'), id('reviewer')]
          );
          // Stands in for whatever the database refuses in a real file: scoped to this
          // fixture's organization and removed in `finally`.
          await c.query(
            `ALTER TABLE pharmacy_medicines ADD CONSTRAINT "${constraint}" CHECK ("organizationId" <> '${id('org')}' OR "productName" <> '${REFUSED}') NOT VALID`
          );

          const context = (who: string) =>
            ({
              db: createTenantDb(id('org'), id(who)),
              entitlements: {
                organizationId: id('org'),
                enabledModules: ['pharmacy-core'],
                activeSeats: 2,
                seatLimit: 10,
                modules: [],
                limits: {},
              },
              session: {
                expires: 'later',
                user: {
                  id: id(who),
                  organizationId: id('org'),
                  role: who === 'cashier' ? 'EMPLOYEE' : 'ADMIN',
                  status: 'ACTIVE',
                },
              },
              organization: null,
              support: null,
              requestMeta: { ip: null, userAgent: null },
              audit: { detail: {} },
            }) as unknown as TRPCContext;
          const editor = pharmacyMedicineRouter.createCaller(context('editor'));
          const reviewer = pharmacyMedicineRouter.createCaller(context('reviewer'));
          const staging = pharmacyStagedReviewRouter.createCaller(
            context('editor')
          ).pharmacyMedicine;
          const runtime = createTenantDb(id('org'), id('editor'));
          assert.deepEqual(
            await runtime.$queryRawUnsafe(
              'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
            ),
            [{ rolsuper: false, rolbypassrls: false }]
          );

          const upload = {
            fileName: 'owner-medicines.csv',
            content: Buffer.from(ownerFile()).toString('base64'),
            branchId: id('branch'),
          };
          const read = await staging.stagingUpload(upload);
          const mapping = read.mapping as { product: number; quantity?: number };
          const staged = await staging.stageBatch({
            ...upload,
            ...(mapping.quantity === undefined ? {} : { quantityUnit: 'PACKS' as const }),
            mapping,
          });
          assert.equal(staged.rowCount, ROWS);
          const batchId = staged.batchId;
          const request = (await editor.createStagedMedicines({ batchId })) as { id: string };
          await reviewer.decideCatalogueEdit({ editId: request.id, decision: 'APPROVE' });

          // The owner's situation: 18 groups of 1,000 created, 933 still to create.
          for (let call = 1; call <= 18; call += 1) {
            const step = await editor.runStagedMedicineCreation({ batchId });
            assert.deepEqual([step.created, step.refused], [1_000, 0]);
          }
          const before = await editor.stagedMedicineCreation({ batchId });
          assert.deepEqual(
            [before.candidates, before.done, before.notCreated, before.remaining],
            [ROWS, 18_000, 0, 933]
          );
          const firstMedicines = await runtime.medicine.findMany({
            select: { id: true, productName: true, controlled: true, updatedAt: true },
            orderBy: { id: 'asc' },
          });
          assert.equal(firstMedicines.length, 18_000);

          // The last group: every valid row is created, the refused row is recorded.
          vi.mocked(recordTrpcAudit).mockClear();
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const last = await editor.runStagedMedicineCreation({ batchId });
          const warned = warn.mock.calls.filter(
            ([message]) => message === '[pharmacy] staged medicine rows not created'
          );
          warn.mockRestore();
          assert.deepEqual(
            [last.created, last.matched, last.refused, last.done, last.notCreated, last.remaining],
            [932, 0, 1, ROWS - 1, 1, 0]
          );
          assert.equal(last.controlled, 1);
          assert.equal(await runtime.medicine.count(), ROWS - 1);
          assert.equal(await runtime.pharmacyStagedMedicineLink.count(), ROWS);
          assert.equal(await runtime.medicine.count({ where: { productName: REFUSED } }), 0);

          const refusedRow = await runtime.pharmacyMigrationRow.findFirstOrThrow({
            where: { batchId, productName: REFUSED },
          });
          const refusedLink = await runtime.pharmacyStagedMedicineLink.findUniqueOrThrow({
            where: {
              organizationId_sourceKey: {
                organizationId: id('org'),
                sourceKey: refusedRow.sourceKey,
              },
            },
          });
          assert.deepEqual(
            [
              refusedLink.outcome,
              refusedLink.medicineId,
              refusedLink.packLevelId,
              refusedLink.matchKey,
              refusedLink.rowId,
            ],
            ['NOT_CREATED', null, null, null, refusedRow.id]
          );
          assert.equal(
            refusedLink.notCreatedReason,
            'A value in this row is not accepted by the catalogue. Correct the row in the file and upload the file again: medicines already created are matched, never made twice.'
          );
          // The row's own detail shows the reason.
          const detail = await staging.stagedDetail({
            branchId: id('branch'),
            sourceId: staged.sourceId,
            batchId,
            rowId: refusedRow.id,
          });
          assert.equal(detail.catalogueMedicine?.outcome, 'NOT_CREATED');
          assert.equal(detail.catalogueMedicine?.notCreatedReason, refusedLink.notCreatedReason);
          // The review lists exactly the rows that could not be created, with their reasons...
          const notCreatedList = await staging.stagedRows({
            branchId: id('branch'),
            sourceId: staged.sourceId,
            batchId,
            filter: 'not-created',
          });
          assert.deepEqual(
            [
              notCreatedList.total,
              notCreatedList.rows.map((row) => [
                row.rowNumber,
                row.productName,
                row.notCreatedReason,
              ]),
            ],
            [1, [[refusedRow.rowNumber, REFUSED, refusedLink.notCreatedReason]]]
          );
          // ...to exactly who may read the staged review: a cashier may not.
          await assert.rejects(
            pharmacyStagedReviewRouter
              .createCaller(context('cashier'))
              .pharmacyMedicine.stagedRows({
                branchId: id('branch'),
                sourceId: staged.sourceId,
                batchId,
                filter: 'not-created',
              }),
            (error: unknown) => (error as { code?: string }).code === 'FORBIDDEN'
          );

          // The technical detail goes to the audit record and the server log: row number and
          // codes, never the row's cells.
          const audited = vi
            .mocked(recordTrpcAudit)
            .mock.calls.map(([call]) => call)
            .find((call) => call.path === 'runStagedMedicineCreation');
          const metadata = (
            audited?.ctx as { audit?: { detail: { metadata?: Record<string, unknown> } } }
          ).audit?.detail.metadata;
          assert.deepEqual(metadata?.notCreatedRows, [
            {
              rowNumber: refusedRow.rowNumber,
              prismaCode: 'P2039',
              sqlState: '23514',
              model: 'Medicine',
              constraint,
              errorName: 'PrismaClientKnownRequestError',
            },
          ]);
          assert.equal(audited?.outcome, 'SUCCESS');
          assert.equal(warned.length, 1);
          assert.deepEqual((warned[0]![1] as { rows: unknown }).rows, metadata?.notCreatedRows);
          assert.ok(!JSON.stringify(warned).includes(REFUSED));

          // The rows that refused a whole group on develop are created.
          const dash = await runtime.medicine.findFirstOrThrow({
            where: { productName: 'Fixture Dash Code' },
            include: { aliases: true },
          });
          assert.deepEqual(dash.aliases, []);
          const dashLink = await runtime.pharmacyStagedMedicineLink.findFirstOrThrow({
            where: { medicineId: dash.id },
          });
          assert.deepEqual([dashLink.outcome, dashLink.legacyCode], ['CREATED', null]);
          const cobalamin = await runtime.medicine.findFirstOrThrow({
            where: { productName: 'Fixture Cobalamin Tab' },
            include: { aliases: true },
          });
          const normalized = await runtime.$queryRaw<{ generic: string; code: string }[]>`
            SELECT pharmacy_normalize_catalog_text('Cyanocobalamin B₁₂') AS "generic",
                   pharmacy_normalize_catalog_text('X²') AS "code"`;
          assert.deepEqual(
            cobalamin.aliases
              .map((alias) => [alias.type, alias.value, alias.normalizedValue])
              .sort(),
            [
              ['GENERIC', 'Cyanocobalamin B₁₂', normalized[0]!.generic],
              ['LEGACY_CODE', 'X²', normalized[0]!.code],
            ]
          );
          const unsearchable = await runtime.medicine.findFirstOrThrow({
            where: { productName: 'Fixture Unsearchable Codes' },
            include: { aliases: true },
          });
          assert.deepEqual(unsearchable.aliases, []);
          const unsearchableLink = await runtime.pharmacyStagedMedicineLink.findFirstOrThrow({
            where: { medicineId: unsearchable.id },
          });
          assert.deepEqual(
            [unsearchableLink.legacyCode, unsearchableLink.aliasesNotAdded],
            ['①', ['½', '①']]
          );
          assert.equal(last.aliasesNotAdded, 1);
          const fraction = await runtime.medicineBarcode.findFirstOrThrow({
            where: { code: 'AB½12' },
          });
          const fractionLink = await runtime.pharmacyStagedMedicineLink.findFirstOrThrow({
            where: { barcode: 'AB½12' },
          });
          assert.equal(fractionLink.barcodeAttached, true);
          assert.equal(fraction.type, 'MANUFACTURER');
          const long = await runtime.medicine.findFirstOrThrow({
            where: { productName: { startsWith: 'LLLL' } },
            include: { provenance: true },
          });
          assert.equal(long.productName, 'L'.repeat(299));
          assert.ok(long.provenance.some((item) => item.field === 'productName'));
          // The barcode already on row 1 stays there and is reported on the later row.
          const repeat = await runtime.pharmacyStagedMedicineLink.findFirstOrThrow({
            where: { legacyCode: 'RB-1' },
          });
          assert.deepEqual([repeat.outcome, repeat.barcodeAttached], ['CREATED', false]);
          assert.equal(
            await runtime.medicineBarcode.count({ where: { normalizedCode: FIRST_BARCODE } }),
            1
          );
          // DEV-854 is unchanged: the NARCOTICS-class row is a controlled medicine.
          assert.equal(
            (
              await runtime.medicine.findFirstOrThrow({
                where: { productName: 'Fixture Last Opioid 5mg' },
              })
            ).controlled,
            true
          );
          assert.equal(
            (
              await runtime.medicine.findFirstOrThrow({
                where: { productName: 'Fixture Zero Pack' },
              })
            ).saleable,
            true
          );

          // Nothing created by the first 18 groups changed.
          const unchanged = await runtime.medicine.findMany({
            where: { id: { in: firstMedicines.map((medicine) => medicine.id) } },
            select: { id: true, productName: true, controlled: true, updatedAt: true },
            orderBy: { id: 'asc' },
          });
          assert.deepEqual(unchanged, firstMedicines);

          // Pressing Create medicines again: finished, nothing twice, the refusal not retried.
          const again = await editor.runStagedMedicineCreation({ batchId });
          assert.deepEqual(
            [again.created, again.matched, again.refused, again.notCreated, again.remaining],
            [0, 0, 0, 1, 0]
          );
          assert.equal(await runtime.medicine.count(), ROWS - 1);
          assert.equal(await runtime.pharmacyStagedMedicineLink.count(), ROWS);
          assert.equal(
            await runtime.pharmacyStagedMedicineLink.count({
              where: { outcome: 'NOT_CREATED' },
            }),
            1
          );
          const final = await reviewer.stagedMedicineCreation({ batchId });
          assert.deepEqual([final.done, final.notCreated, final.remaining], [ROWS - 1, 1, 0]);
          // The record of the refusal is evidence: it cannot be changed or removed.
          assert.equal(
            (
              await runtime.pharmacyStagedMedicineLink.updateMany({
                where: { outcome: 'NOT_CREATED' },
                data: { notCreatedReason: 'changed' },
              })
            ).count,
            0
          );
          assert.equal(
            (
              await runtime.pharmacyStagedMedicineLink.deleteMany({
                where: { outcome: 'NOT_CREATED' },
              })
            ).count,
            0
          );
        } finally {
          await c.query(`ALTER TABLE pharmacy_medicines DROP CONSTRAINT IF EXISTS "${constraint}"`);
          await c.end();
        }
      }
    );
  }
);
