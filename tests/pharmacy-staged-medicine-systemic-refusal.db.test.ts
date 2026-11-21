/**
 * DEV-1002: a NOT_CREATED record is permanent, so it is kept for rows that are bad themselves.
 * When the database refuses every row of a step, or more than 25 rows for one and the same
 * reason, the cause is not the rows: the step is undone, nothing is recorded, the person reads
 * a plain stop message, and the step runs normally once the cause is removed. Three bad rows in
 * a step of 1,000 are still recorded one by one. Runs under a restricted PostgreSQL runtime role
 * with forced row-level security; skipped (never silently passed) without the database URLs.
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

const HEADER = 'Name,aliasname,PackUnits,saleprice,purprice,QTY,classname,Generic Name,Pack Type';
// Each row's old code is its own name, so no row matches a medicine an earlier file created.
const file = (names: string[]) =>
  [
    HEADER,
    ...names.map((name) => `${name},${name.replace(/ /g, '-')},10,50.00,40.00,1,GENERAL,,`),
  ].join('\n') + '\n';
const STOPPED =
  'Creating stopped: many rows were refused for the same reason: a value is not accepted by the catalogue. Nothing was recorded for these rows, and medicines already created are kept. Tell your administrator.';

(ownerUrl && runtimeUrl ? describe : describe.skip)(
  'DEV-1002 a refusal of every row stops the step and records nothing',
  () => {
    it(
      'undoes a step refused for one shared cause, and still records a few bad rows',
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
        const prefix = 'dv1002s_' + randomUUID().slice(0, 8);
        const id = (x: string) => prefix + '_' + x;
        const refuse = `${prefix}_refuse`;
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
            `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW','fixture',now())`,
            [id('review'), id('org'), id('reviewer')]
          );
          // The reviewer's probe: a database rule that refuses new medicines of this fixture
          // organization whose name matches a pattern, with a foreign-key error (23503). It
          // starts refusing nothing; `refusing` below sets the pattern.
          await c.query(
            `CREATE FUNCTION "${refuse}"() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$`
          );
          await c.query(
            `CREATE TRIGGER "${refuse}" BEFORE INSERT ON pharmacy_medicines FOR EACH ROW EXECUTE FUNCTION "${refuse}"()`
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

          async function approvedFile(fileName: string, names: string[]) {
            const upload = {
              fileName,
              content: Buffer.from(file(names)).toString('base64'),
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
            return staged.batchId;
          }
          /** Set the name pattern the fixture rule refuses; '' refuses nothing. */
          async function refusing(pattern: string) {
            await c.query(
              `CREATE OR REPLACE FUNCTION "${refuse}"() RETURNS trigger LANGUAGE plpgsql AS $f$
               BEGIN
                 IF NEW."organizationId" = '${id('org')}' AND NEW."productName" LIKE '${pattern}' THEN
                   RAISE EXCEPTION 'fixture refusal' USING ERRCODE = '23503';
                 END IF;
                 RETURN NEW;
               END $f$`
            );
          }
          async function stopped(batchId: string) {
            await assert.rejects(
              editor.runStagedMedicineCreation({ batchId }),
              (error: unknown) => {
                assert.equal((error as { code?: string }).code, 'INTERNAL_SERVER_ERROR');
                assert.equal((error as Error).message, STOPPED);
                return true;
              }
            );
          }

          // 1. Every row of a 1,000-row step refused for one cause: stopped, nothing recorded.
          const systemic = await approvedFile(
            'systemic.csv',
            Array.from({ length: 1_000 }, (_, n) => `Fixture Systemic ${n + 1}`)
          );
          await refusing('Fixture Systemic%');
          vi.mocked(recordTrpcAudit).mockClear();
          const error = vi.spyOn(console, 'error').mockImplementation(() => {});
          const started = Date.now();
          await stopped(systemic);
          const seconds = (Date.now() - started) / 1000;
          error.mockRestore();
          console.info(`DEV-1002: a step of 1,000 refused rows stopped in ${seconds.toFixed(1)} s`);
          // Stopped early, well inside the step's 120 s transaction limit.
          assert.ok(seconds < 60, `stopped in ${seconds} s`);
          assert.equal(await runtime.pharmacyStagedMedicineLink.count(), 0);
          assert.equal(await runtime.medicine.count(), 0);
          const before = await editor.stagedMedicineCreation({ batchId: systemic });
          assert.deepEqual([before.done, before.notCreated, before.remaining], [0, 0, 1_000]);
          const audited = vi
            .mocked(recordTrpcAudit)
            .mock.calls.map(([call]) => call)
            .find((call) => call.path === 'runStagedMedicineCreation');
          const metadata = (
            audited?.ctx as { audit?: { detail: { metadata?: Record<string, unknown> } } }
          ).audit?.detail.metadata;
          assert.deepEqual(metadata?.stopped, {
            systemic: true,
            rows: 26,
            prismaCode: 'P2003',
            sqlState: '23503',
            model: 'Medicine',
            constraint: null,
            errorName: 'PrismaClientKnownRequestError',
          });

          // Pressing Create medicines again after the cause is removed creates every row.
          await refusing('');
          const retried = await editor.runStagedMedicineCreation({ batchId: systemic });
          assert.deepEqual(
            [retried.created, retried.refused, retried.notCreated, retried.remaining],
            [1_000, 0, 0, 0]
          );

          // 2. Every row of a small step refused: stopped too, nothing recorded.
          const tiny = await approvedFile('tiny.csv', [
            'Fixture Tiny 1',
            'Fixture Tiny 2',
            'Fixture Tiny 3',
            'Fixture Tiny 4',
          ]);
          await refusing('Fixture Tiny%');
          await stopped(tiny);
          assert.equal(
            await runtime.pharmacyStagedMedicineLink.count({ where: { batchId: tiny } }),
            0
          );

          // 3. Three bad rows among 1,000: recorded one by one, the other 997 created.
          const names = Array.from({ length: 1_000 }, (_, n) => `Fixture Mixed ${n + 1}`);
          for (const n of [10, 500, 990]) names[n] = `Fixture Bad Row ${n}`;
          const mixed = await approvedFile('mixed.csv', names);
          await refusing('Fixture Bad Row%');
          const step = await editor.runStagedMedicineCreation({ batchId: mixed });
          assert.deepEqual(
            [step.created, step.refused, step.notCreated, step.remaining],
            [997, 3, 3, 0]
          );
          const recorded = await runtime.pharmacyStagedMedicineLink.findMany({
            where: { batchId: mixed, outcome: 'NOT_CREATED' },
            select: { medicineId: true, notCreatedReason: true },
          });
          assert.equal(recorded.length, 3);
          for (const link of recorded) {
            assert.equal(link.medicineId, null);
            assert.match(link.notCreatedReason ?? '', /^A value in this row is not accepted/);
          }

          // 4. The worst case still recorded row by row: exactly 25 rows refused for one cause,
          // spread through a step of 1,000. Each is isolated; the step stays well inside 120 s.
          const spread = Array.from({ length: 1_000 }, (_, n) => `Fixture Spread ${n + 1}`);
          for (let n = 20; n < 1_000; n += 40) spread[n] = `Fixture Bad Spread ${n}`;
          const worst = await approvedFile('spread.csv', spread);
          await refusing('Fixture Bad Spread%');
          const worstStarted = Date.now();
          const worstStep = await editor.runStagedMedicineCreation({ batchId: worst });
          const worstSeconds = (Date.now() - worstStarted) / 1000;
          console.info(
            `DEV-1002: 25 refused rows in a step of 1,000 took ${worstSeconds.toFixed(1)} s`
          );
          assert.deepEqual([worstStep.created, worstStep.refused], [975, 25]);
          assert.ok(worstSeconds < 120, `took ${worstSeconds} s`);
        } finally {
          await c.query(`DROP TRIGGER IF EXISTS "${refuse}" ON pharmacy_medicines`);
          await c.query(`DROP FUNCTION IF EXISTS "${refuse}"()`);
          await c.end();
        }
      }
    );
  }
);
