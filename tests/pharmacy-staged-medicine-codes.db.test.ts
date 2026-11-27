/**
 * DEV-1004 (follow-ups of DEV-1002): what staged medicine creation does with barcodes and with a
 * last step whose rows are refused for different reasons, under a restricted PostgreSQL runtime
 * role with forced row-level security.
 *   - A barcode the database reads differently from a scan at the counter ("AB½12") could be
 *     stored but never scanned: the medicine is created, the barcode reported as not added.
 *   - A barcode longer than the catalogue holds (64) is reported as read, never cut to a shorter
 *     code that is not the one on the pack.
 *   - Two rows of one step with the same barcode, the first refused outright by the database:
 *     the second row gets the barcode.
 *   - A step of exactly two rows refused for two different reasons is two bad rows, recorded
 *     one by one: it is not stopped as "refused for the same reason".
 *   - The review lists the created rows whose codes or barcodes were not added.
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
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const HEADER =
  'Name,aliasname,PackUnits,saleprice,purprice,QTY,classname,Generic Name,Pack Type,Barcode';
const SHARED_BARCODE = 'DUP-1004-77';
const LONG_BARCODE = '9'.repeat(70);
const REFUSED_A = 'Fixture Refused By Rule A';
const REFUSED_B = 'Fixture Refused By Rule B';

(ownerUrl && runtimeUrl ? describe : describe.skip)(
  'DEV-1004 staged medicine creation: barcodes and refusals of different causes',
  () => {
    it(
      'attaches only scannable whole barcodes, passes a refused row’s barcode on, and records two different refusals',
      { timeout: 600_000 },
      async () => {
        assertDisposableRlsDatabase(ownerUrl);
        assertDisposableRlsDatabase(runtimeUrl);
        const { pharmacyMedicineRouter } = await import('@/server/routers/pharmacy-medicine');
        const { pharmacyStagedReviewRouter } =
          await import('@/server/routers/pharmacy-staged-review');
        const { createTenantDb } = await import('@/lib/tenancy/scoped-db');

        const c = new pg.Client({ connectionString: ownerUrl });
        await c.connect();
        const prefix = 'dv1004_' + randomUUID().slice(0, 8);
        const id = (x: string) => prefix + '_' + x;
        const ruleA = `${prefix}_rule_a`;
        const ruleB = `${prefix}_rule_b`;
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
          for (const who of ['editor', 'reviewer'])
            await c.query(
              `INSERT INTO users (id,"organizationId",name,email,department,title,role,"updatedAt") VALUES ($1,$2,$1,$1,'Pharmacy','Staff','ADMIN',now())`,
              [id(who), id('org')]
            );
          await c.query(
            `INSERT INTO pharmacy_branch_assignments (id,"organizationId","branchId","userId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
            [id('reviewer_assignment'), id('org'), id('branch'), id('reviewer')]
          );
          await c.query(
            `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW','fixture',now())`,
            [id('review'), id('org'), id('reviewer')]
          );
          // Two different database rules, each standing in for one cause of refusal: scoped to
          // this fixture's organization and removed in `finally`.
          await c.query(
            `ALTER TABLE pharmacy_medicines ADD CONSTRAINT "${ruleA}" CHECK ("organizationId" <> '${id('org')}' OR "productName" NOT LIKE '${REFUSED_A}%') NOT VALID`
          );
          await c.query(
            `ALTER TABLE pharmacy_medicines ADD CONSTRAINT "${ruleB}" CHECK ("organizationId" <> '${id('org')}' OR "productName" <> '${REFUSED_B}') NOT VALID`
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
                user: { id: id(who), organizationId: id('org'), role: 'ADMIN', status: 'ACTIVE' },
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

          /** Stage a file, have it approved, and run its creation steps until it finishes. */
          async function createFrom(fileName: string, lines: string[]) {
            const upload = {
              fileName,
              content: Buffer.from([HEADER, ...lines].join('\n') + '\n').toString('base64'),
              branchId: id('branch'),
            };
            const read = await staging.stagingUpload(upload);
            const mapping = read.mapping as { product: number; quantity?: number };
            const staged = await staging.stageBatch({
              ...upload,
              ...(mapping.quantity === undefined ? {} : { quantityUnit: 'PACKS' as const }),
              mapping,
            });
            const request = (await editor.createStagedMedicines({
              batchId: staged.batchId,
            })) as { id: string };
            await reviewer.decideCatalogueEdit({ editId: request.id, decision: 'APPROVE' });
            const step = await editor.runStagedMedicineCreation({ batchId: staged.batchId });
            return { staged, step };
          }
          /** The link of the row with this old code (a refused row's link records no code). */
          const linkOf = async (legacyCode: string) => {
            const row = await runtime.pharmacyMigrationRow.findFirstOrThrow({
              where: { rawPayload: { path: ['aliasname'], equals: legacyCode } },
              select: { sourceKey: true },
            });
            return runtime.pharmacyStagedMedicineLink.findFirstOrThrow({
              where: { sourceKey: row.sourceKey },
            });
          };

          // One step: a refused row holding a barcode, then a valid row with the same barcode,
          // a barcode the database reads differently, an over-long barcode and a plain one.
          const first = await createFrom('dev-1004-codes.csv', [
            `${REFUSED_A} 1,RA-1,10,30.00,20.00,1,TABLETS,,,${SHARED_BARCODE}`,
            `Fixture Shared Barcode,SB-1,10,30.00,20.00,1,TABLETS,,,${SHARED_BARCODE}`,
            'Fixture Fraction Barcode,FB-1,10,30.00,20.00,1,TABLETS,,,AB½12',
            `Fixture Long Barcode,LB-1,10,30.00,20.00,1,TABLETS,,,${LONG_BARCODE}`,
            'Fixture Maker Code,MC-1,10,30.00,20.00,1,TABLETS,,,MK-1004',
          ]);
          assert.deepEqual(
            [first.step.created, first.step.refused, first.step.remaining],
            [4, 1, 0]
          );
          assert.equal((await linkOf('RA-1')).outcome, 'NOT_CREATED');

          // The row after the refused one keeps the barcode they shared.
          const shared = await linkOf('SB-1');
          assert.deepEqual([shared.outcome, shared.barcodeAttached], ['CREATED', true]);
          const sharedBarcode = await runtime.medicineBarcode.findFirstOrThrow({
            where: { code: SHARED_BARCODE },
            include: { presentation: { select: { medicineId: true } } },
          });
          assert.equal(sharedBarcode.presentation.medicineId, shared.medicineId);
          assert.ok(
            (
              await runtime.medicineProvenance.findMany({
                where: { medicineId: shared.medicineId!, field: 'barcode' },
              })
            ).length === 1
          );

          // "AB½12": the scan would not find it, so it is not attached and is reported.
          const fraction = await linkOf('FB-1');
          assert.deepEqual(
            [fraction.outcome, fraction.barcode, fraction.barcodeAttached],
            ['CREATED', 'AB½12', false]
          );
          assert.equal(await runtime.medicineBarcode.count({ where: { code: 'AB½12' } }), 0);
          // No import record claims a barcode the medicine does not hold.
          assert.equal(
            await runtime.medicineProvenance.count({
              where: { medicineId: fraction.medicineId!, field: 'barcode' },
            }),
            0
          );

          // The over-long barcode is reported whole, never cut to its first 64 characters.
          const long = await linkOf('LB-1');
          assert.deepEqual(
            [long.outcome, long.barcode, long.barcodeAttached],
            ['CREATED', LONG_BARCODE, false]
          );
          assert.equal(
            await runtime.medicineBarcode.count({
              where: { code: { startsWith: '9'.repeat(64) } },
            }),
            0
          );

          // A plain maker's code is attached as before.
          const maker = await runtime.medicineBarcode.findFirstOrThrow({
            where: { code: 'MK-1004' },
          });
          assert.equal(maker.type, 'MANUFACTURER');
          assert.equal((await linkOf('MC-1')).barcodeAttached, true);

          // The progress counts both not-added barcodes, and the review lists exactly those rows.
          const progress = await editor.stagedMedicineCreation({
            batchId: first.staged.batchId,
          });
          assert.equal(progress.barcodesNotAttached, 2);
          const listed = await staging.stagedRows({
            branchId: id('branch'),
            sourceId: first.staged.sourceId,
            batchId: first.staged.batchId,
            filter: 'codes-not-added',
          });
          assert.deepEqual(listed.rows.map((row) => row.productName).sort(), [
            'Fixture Fraction Barcode',
            'Fixture Long Barcode',
          ]);

          // A last step of exactly two rows, refused for two different reasons: both recorded.
          const second = await createFrom('dev-1004-two-causes.csv', [
            `${REFUSED_A} 2,RA-2,10,30.00,20.00,1,TABLETS,,,`,
            `${REFUSED_B},RB-2,10,30.00,20.00,1,TABLETS,,,`,
          ]);
          assert.deepEqual(
            [
              second.step.created,
              second.step.refused,
              second.step.notCreated,
              second.step.remaining,
            ],
            [0, 2, 2, 0]
          );
          assert.deepEqual(
            [(await linkOf('RA-2')).outcome, (await linkOf('RB-2')).outcome],
            ['NOT_CREATED', 'NOT_CREATED']
          );
          // Pressing Create medicines again finishes with nothing more to do.
          const again = await editor.runStagedMedicineCreation({
            batchId: second.staged.batchId,
          });
          assert.deepEqual([again.created, again.refused, again.remaining], [0, 0, 0]);
        } finally {
          await c.query(`ALTER TABLE pharmacy_medicines DROP CONSTRAINT IF EXISTS "${ruleA}"`);
          await c.query(`ALTER TABLE pharmacy_medicines DROP CONSTRAINT IF EXISTS "${ruleB}"`);
          await c.end();
        }
      }
    );
  }
);
