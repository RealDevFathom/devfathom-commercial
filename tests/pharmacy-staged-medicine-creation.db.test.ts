/**
 * DEV-912: a staged legacy product file (about 19,000 rows) becomes catalogue medicines through
 * one approved request, under a restricted PostgreSQL runtime role with forced row-level security.
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
// Approval audit records are written to the real database; only automatic request logging
// is suppressed to keep the fixture bounded.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const ROWS = 19_000;

const HEADER =
  'Name,aliasname,PackUnits,saleprice,purprice,QTY,classname,Generic Name,Pack Type,Barcode';
const BARCODE = '0896000000017';

/** A legacy export in the old desktop system's headers, plus generic-name and barcode columns. */
function legacyFile() {
  const lines = [HEADER];
  lines.push(
    `Fixture Box Of Strips,LC-1,10 x 10,1000.00,800.00,3,TABLETS,Fixture Salt,,${BARCODE}`
  );
  // The same barcode again: reported and skipped, the medicine still created.
  lines.push(`Fixture Box Tablet,LC-2,100,500.00,420.00,1,TABLETS,,Box,${BARCODE}`);
  lines.push('Fixture Strip Tablet,LC-3,10,120.00,96.00,4,TABLETS,,Strip,');
  lines.push('Fixture Single Tablet,LC-4,1,15.00,11.50,9,TABLETS,,,');
  lines.push('Fixture Name Only Syrup,,,,,,,,,');
  lines.push('Fixture Opioid 10mg,LC-6,10,250.00,200.00,2,NARCOTICS,,,');
  lines.push(',LC-7,10,10.00,8.00,5,TABLETS,,,');
  lines.push('Fixture Zero Price,LC-8,10,0.00,0.00,1,TABLETS,,,');
  for (let n = lines.length; n <= ROWS; n += 1)
    lines.push(`Fixture Bulk Item ${n},B${n},10,50.00,40.00,${n % 7},GENERAL,,,`);
  return lines.join('\n') + '\n';
}

/** A small catalogue, and the same catalogue exported again: other bytes, one new item. */
const soloFirst = [
  HEADER,
  'Solo Coded Tablet,S-1,10,100.00,80.00,1,TABLETS,,,',
  'Solo Codeless Syrup,,1,90.00,70.00,1,SYRUPS,,,',
  'Solo Other Capsule,S-3,20,200.00,150.00,1,CAPSULES,,,',
  // One name, two strengths, the strength in the pack cell and no old code.
  'Solo Strength Tab,,500MG,30.00,20.00,1,TABLETS,,,',
  'Solo Strength Tab,,250MG,20.00,15.00,1,TABLETS,,,',
  // Nothing but a name: never matched by name alone.
  'Solo Name Only,,,,,,,,,',
].join('\n');
const MATCHED_BARCODE = '0896000000024';
const soloReexport = [
  HEADER,
  'Solo Coded Tablet 10s,S-1,10,110.00,85.00,4,TABLETS,,,',
  'solo  codeless syrup,,1,95.00,72.00,2,SYRUPS,,,',
  `Solo Other Capsule,S-3,20,210.00,155.00,3,CAPSULES,,,${MATCHED_BARCODE}`,
  'Solo New Item,S-9,10,50.00,40.00,1,TABLETS,,,',
  'Solo Strength Tab,,250MG,21.00,16.00,1,TABLETS,,,',
  'Solo Strength Tab,,500MG,31.00,21.00,1,TABLETS,,,',
  'Solo Name Only,,,,,,,,,',
].join('\r\n');

/**
 * The medicine import template, products only: no quantity column, so no packs-or-units choice.
 * Suppliers are matched to existing ones by exact normalised name; reorder levels are packs.
 */
const soloTemplate = [
  'Product name,Units per pack,MRP,Purchase price,Supplier,Reorder level,Legacy code',
  'Template Known Supplier,10,100.00,80.00,  solo   DISTRIBUTORS ,20,T-1',
  'Template Unknown Supplier,10,100.00,80.00,Nobody Wholesale,5,T-2',
  'Template No Pack Size,,100.00,80.00,Solo Distributors,7,T-3',
  'Template Twin Supplier,10,100.00,80.00,Twin Traders,3,T-4',
  'Template Name Only,,,,,,',
].join('\n');

(ownerUrl && runtimeUrl ? describe : describe.skip)(
  'DEV-912 staged medicine creation under restricted PostgreSQL runtime',
  () => {
    it(
      'creates 19,000 medicines once, after one independent approval, with prices and packs',
      {
        timeout: 1_800_000,
      },
      async () => {
        assertDisposableRlsDatabase(ownerUrl);
        assertDisposableRlsDatabase(runtimeUrl);
        const { pharmacyMedicineRouter } = await import('@/server/routers/pharmacy-medicine');
        const { pharmacyStagedReviewRouter } =
          await import('@/server/routers/pharmacy-staged-review');
        const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
        const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
        const { stagedLevelPrices } = await import('@/lib/pharmacy/migration/staged-creation');

        const c = new pg.Client({ connectionString: ownerUrl });
        await c.connect();
        try {
          const prefix = 'stc_' + randomUUID().slice(0, 8);
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
            await c.query(
              `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,'MAIN','Main','Fixture street','Lahore','PB',now())`,
              [id('branch_' + org), id(org)]
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
            for (const who of org === 'solo' ? ['owner'] : ['editor', 'reviewer', 'cashier']) {
              await c.query(
                `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,"updatedAt") VALUES ($1,$2,$3,$1,$1,'Pharmacy','Staff',$4,now())`,
                [
                  id(who + '_' + org),
                  id(org),
                  org === 'solo' ? id('ownerrole') : null,
                  who === 'cashier' ? 'EMPLOYEE' : 'ADMIN',
                ]
              );
              if (who === 'reviewer')
                await c.query(
                  `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW','fixture',now())`,
                  [id('review_' + org), id(org), id(who + '_' + org)]
                );
            }
          }
          await c.query(
            `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,'Fixture owner','ACTIVE',now())`,
            [id('staff'), id('solo'), id('owner_solo')]
          );
          await c.query(
            `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
            [id('credential'), id('solo'), id('staff'), await hashOperatorCredential('PIN', '2468')]
          );
          const context = (org: string, who: string) =>
            ({
              db: createTenantDb(id(org), id(who + '_' + org)),
              entitlements: {
                organizationId: id(org),
                enabledModules: ['pharmacy-core'],
                activeSeats: 3,
                seatLimit: 10,
                modules: [],
                limits: {},
              },
              session: {
                expires: 'later',
                user: {
                  id: id(who + '_' + org),
                  organizationId: id(org),
                  role: who === 'cashier' ? 'EMPLOYEE' : 'ADMIN',
                  status: 'ACTIVE',
                },
              },
              organization: null,
              support: null,
              requestMeta: { ip: null, userAgent: null },
              audit: { detail: {} },
            }) as unknown as TRPCContext;
          const medicine = (org: string, who: string) =>
            pharmacyMedicineRouter.createCaller(context(org, who));
          const staging = (org: string) =>
            pharmacyStagedReviewRouter.createCaller(
              context(org, org === 'solo' ? 'owner' : 'editor')
            ).pharmacyMedicine;
          async function refusal(p: Promise<unknown>, code: string) {
            await assert.rejects(p, (error: unknown) =>
              Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
            );
          }
          const file = legacyFile();
          async function stage(org: string, fileName = 'abuzar-products.csv', text = file) {
            const upload = {
              fileName,
              content: Buffer.from(text).toString('base64'),
              branchId: id('branch_' + org),
            };
            const read = await staging(org).stagingUpload(upload);
            const mapping = read.mapping as { product: number; quantity?: number };
            return staging(org).stageBatch({
              ...upload,
              ...(mapping.quantity === undefined ? {} : { quantityUnit: 'PACKS' as const }),
              mapping,
            });
          }

          const editor = medicine('a', 'editor');
          const reviewer = medicine('a', 'reviewer');
          const cashier = medicine('a', 'cashier');
          const runtime = createTenantDb(id('a'), id('editor_a'));
          const flags = await runtime.$queryRawUnsafe<
            { rolsuper: boolean; rolbypassrls: boolean }[]
          >('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
          assert.deepEqual(flags, [{ rolsuper: false, rolbypassrls: false }]);

          const staged = await stage('a');
          assert.equal(staged.rowCount, ROWS);
          const batchId = staged.batchId;

          // A cashier cannot ask for, run or read a bulk creation.
          await refusal(cashier.createStagedMedicines({ batchId }), 'FORBIDDEN');
          await refusal(cashier.runStagedMedicineCreation({ batchId }), 'FORBIDDEN');

          // The editor names a branch, but holds no stock control there: no reorder branch.
          const request = await editor.createStagedMedicines({ batchId, branchId: id('branch_a') });
          assert.equal((request as { status: string }).status, 'PENDING');
          assert.equal(
            (request as unknown as { changes: { json: { reorderBranchId: string | null } } })
              .changes.json.reorderBranchId,
            null
          );
          assert.equal((request as { medicineId: string | null }).medicineId, null);
          // Asking again returns the same request.
          assert.equal(
            ((await editor.createStagedMedicines({ batchId })) as { id: string }).id,
            (request as { id: string }).id
          );
          const pending = await editor.stagedMedicineCreation({ batchId });
          assert.equal(pending.request?.status, 'PENDING');
          assert.equal(pending.candidates, ROWS - 1);
          assert.equal(pending.unnamed, 1);
          assert.equal(await runtime.medicine.count(), 0);
          // Nothing is created before approval, and the editor cannot approve their own request.
          await refusal(editor.runStagedMedicineCreation({ batchId }), 'PRECONDITION_FAILED');
          await refusal(
            editor.decideCatalogueEdit({
              editId: (request as { id: string }).id,
              decision: 'APPROVE',
              soloPin: '2468',
            }),
            'FORBIDDEN'
          );
          // The reviewer sees one queue entry for the whole file.
          const queued = (await reviewer.catalogueEdits()).find(
            (edit) => edit.id === (request as { id: string }).id
          );
          assert.equal(queued?.medicine.productName, 'New medicines from an imported file');
          assert.equal(
            (queued?.changes as { json: { medicines: number } }).json.medicines,
            ROWS - 1
          );
          await reviewer.decideCatalogueEdit({
            editId: (request as { id: string }).id,
            decision: 'APPROVE',
          });
          assert.equal(
            await runtime.auditLog.count({
              where: {
                action: 'pharmacy.catalogueApproval',
                targetId: (request as { id: string }).id,
              },
            }),
            1
          );

          const started = Date.now();
          let created = 0;
          let controlled = 0;
          let calls = 0;
          for (;;) {
            const step = await editor.runStagedMedicineCreation({ batchId });
            calls += 1;
            created += step.created;
            controlled += step.controlled;
            if (step.remaining === 0) break;
            assert.ok(calls < 200, 'creation must finish in chunks');
          }
          const seconds = (Date.now() - started) / 1000;
          console.info(`DEV-912: ${created} medicines in ${calls} calls, ${seconds.toFixed(1)} s`);
          assert.equal(created, ROWS - 1);
          assert.equal(controlled, 1);
          assert.equal(await runtime.medicine.count(), ROWS - 1);
          assert.equal(await runtime.pharmacyStagedMedicineLink.count(), ROWS - 1);

          // Idempotent: running again, or staging the same file again, creates nothing twice.
          const again = await reviewer.runStagedMedicineCreation({ batchId });
          assert.deepEqual([again.created, again.remaining], [0, 0]);
          const restaged = await stage('a');
          assert.equal(restaged.batchId, batchId);
          assert.equal((await editor.runStagedMedicineCreation({ batchId })).created, 0);
          assert.equal(await runtime.medicine.count(), ROWS - 1);

          async function created1(productName: string) {
            const found = await runtime.medicine.findFirstOrThrow({
              where: { productName },
              include: {
                aliases: true,
                provenance: true,
                presentations: { include: { packLevels: true } },
              },
            });
            const link = await runtime.pharmacyStagedMedicineLink.findFirstOrThrow({
              where: { medicineId: found.id },
            });
            const prices = await runtime.pharmacyPackPrice.findMany({
              where: { presentationId: found.presentations[0]!.id },
            });
            const levels = [...found.presentations[0]!.packLevels].sort((x, y) =>
              x.parentPackLevelId === null ? -1 : y.parentPackLevelId === null ? 1 : 0
            );
            return { found, link, prices, levels };
          }
          // A box of strips: MRP on the box, a strip and a tablet priced from the units per pack.
          const box = await created1('Fixture Box Of Strips');
          assert.deepEqual(
            box.levels.map((level) => [level.level, level.unitsPerParent]),
            [
              ['BOX', 10],
              ['STRIP', 10],
            ]
          );
          assert.equal(box.levels[1]!.parentPackLevelId, box.levels[0]!.id);
          assert.deepEqual(
            box.prices.map((price) => [
              price.packLevelId,
              price.mrpMinor,
              price.source,
              price.createdById,
              price.proposedById,
            ]),
            [[box.levels[0]!.id, 100_000, 'import', id('reviewer_a'), id('editor_a')]]
          );
          assert.deepEqual([box.link.mrpMinor, box.link.purchasePriceMinor], [100_000, 80_000]);
          assert.equal(box.link.legacyCode, 'LC-1');
          assert.deepEqual(box.found.aliases.map((alias) => [alias.type, alias.value]).sort(), [
            ['GENERIC', 'Fixture Salt'],
            ['LEGACY_CODE', 'LC-1'],
          ]);
          assert.equal(box.found.saleable, true);
          assert.equal(box.found.controlled, false);
          assert.ok(
            box.found.provenance.every(
              (item) =>
                item.sourceType === 'IMPORT' &&
                item.status === 'ACCEPTED' &&
                item.reviewer === id('reviewer_a') &&
                item.editorId === id('editor_a')
            )
          );
          const boxPrices = stagedLevelPrices({
            mrpMinor: box.prices[0]!.mrpMinor,
            packLevels: box.levels.map((level) => ({
              level: level.level as 'BOX',
              unitsPerParent: level.unitsPerParent,
            })),
          });
          assert.deepEqual(boxPrices, {
            levels: [
              { level: 'BOX', priceMinor: 100_000 },
              { level: 'STRIP', priceMinor: 10_000 },
            ],
            unitPriceMinor: 1_000,
          });

          // The staged row's detail names the medicine made from it, with its prices.
          const boxRow = await runtime.pharmacyMigrationRow.findFirstOrThrow({
            where: { batchId, productName: 'Fixture Box Of Strips' },
          });
          const detail = await staging('a').stagedDetail({
            branchId: id('branch_a'),
            sourceId: staged.sourceId,
            batchId,
            rowId: boxRow.id,
          });
          assert.deepEqual(detail.catalogueMedicine, {
            medicineId: box.found.id,
            mrpMinor: 100_000,
            purchasePriceMinor: 80_000,
            unitsPerPack: 100,
            outcome: 'CREATED',
            notCreatedReason: null,
            barcode: BARCODE,
            barcodeAttached: true,
            supplierName: null,
            supplierId: null,
            reorderLevelPacks: null,
            reorderLevelApplied: null,
          });
          // The barcode is on the box, and only once in the organization.
          const barcodes = await runtime.medicineBarcode.findMany({
            where: { normalizedCode: BARCODE },
          });
          assert.deepEqual(
            barcodes.map((barcode) => [barcode.presentationId, barcode.packLevelId, barcode.type]),
            [[box.found.presentations[0]!.id, box.levels[0]!.id, 'GTIN']]
          );

          // The purchase price is the owner's and managers' only: the reviewer (no
          // `pharmacy:manage`) and the cashier get neither the price nor its provenance.
          for (const who of [reviewer, cashier]) {
            const read = await who.get({ id: box.found.id });
            assert.deepEqual([read.purchasePriceVisible, read.purchasePrice], [false, null]);
            assert.ok(read.provenance.length > 0);
            assert.ok(read.provenance.every((item) => item.field !== 'purchasePriceMinor'));
          }

          const plainBox = await created1('Fixture Box Tablet');
          assert.deepEqual(
            plainBox.levels.map((level) => [level.level, level.unitsPerParent]),
            [['BOX', 100]]
          );
          // Its barcode already belonged to the box of strips: reported, not moved, not added.
          assert.deepEqual(
            [plainBox.link.barcode, plainBox.link.barcodeAttached, plainBox.found.saleable],
            [BARCODE, false, true]
          );
          const finished = await editor.stagedMedicineCreation({ batchId });
          assert.deepEqual([finished.barcodesNotAttached, finished.matchedEarlier], [1, 0]);

          // A price of 0 is stored as not recorded, never as 0.
          const zero = await created1('Fixture Zero Price');
          assert.deepEqual(zero.prices, []);
          assert.deepEqual([zero.link.mrpMinor, zero.link.purchasePriceMinor], [null, null]);
          const strip = await created1('Fixture Strip Tablet');
          assert.deepEqual(
            strip.levels.map((level) => [level.level, level.unitsPerParent]),
            [['STRIP', 10]]
          );
          assert.deepEqual(
            [strip.prices[0]!.mrpMinor, strip.link.purchasePriceMinor],
            [12_000, 9_600]
          );
          const single = await created1('Fixture Single Tablet');
          assert.deepEqual(
            single.levels.map((level) => [level.level, level.unitsPerParent]),
            [['UNIT', 1]]
          );
          assert.deepEqual(
            [single.prices[0]!.mrpMinor, single.link.purchasePriceMinor],
            [1_500, 1_150]
          );

          // A row with only a name: created, prices and pack stored as not recorded.
          const nameOnly = await created1('Fixture Name Only Syrup');
          assert.equal(nameOnly.found.saleable, true);
          assert.equal(nameOnly.found.presentations[0]!.presentation, 'Pack size not recorded');
          assert.deepEqual(nameOnly.levels, []);
          assert.deepEqual(nameOnly.prices, []);
          assert.deepEqual(
            [nameOnly.link.mrpMinor, nameOnly.link.purchasePriceMinor, nameOnly.link.unitsPerPack],
            [null, null, null]
          );

          // DEV-854: the NARCOTICS-class row becomes a controlled medicine.
          assert.equal((await created1('Fixture Opioid 10mg')).found.controlled, true);
          assert.equal(await runtime.medicine.count({ where: { controlled: true } }), 1);

          // Another workspace sees nothing and cannot run this batch.
          await refusal(
            medicine('b', 'reviewer').runStagedMedicineCreation({ batchId }),
            'PRECONDITION_FAILED'
          );
          assert.equal(await createTenantDb(id('b'), id('reviewer_b')).medicine.count(), 0);
          // The link record is evidence: it cannot be changed or removed.
          assert.equal(
            (
              await runtime.pharmacyStagedMedicineLink.updateMany({
                data: { legacyCode: 'changed' },
              })
            ).count,
            0
          );
          assert.equal((await runtime.pharmacyStagedMedicineLink.deleteMany({})).count, 0);

          // Solo owner: asks, then approves their own request only with a fresh PIN.
          const solo = medicine('solo', 'owner');
          const soloBatch = (await stage('solo', 'solo-products.csv', soloFirst)).batchId;
          const soloRequest = (await solo.createStagedMedicines({ batchId: soloBatch })) as {
            id: string;
          };
          await refusal(
            solo.decideCatalogueEdit({ editId: soloRequest.id, decision: 'APPROVE' }),
            'FORBIDDEN'
          );
          await solo.decideCatalogueEdit({
            editId: soloRequest.id,
            decision: 'APPROVE',
            soloPin: '2468',
          });
          const solodb = createTenantDb(id('solo'), id('owner_solo'));
          assert.equal(
            await solodb.auditLog.count({
              where: { action: 'pharmacy.catalogueSoloOwnerApproval', targetId: soloRequest.id },
            }),
            1
          );
          const soloStep = await solo.runStagedMedicineCreation({ batchId: soloBatch });
          assert.deepEqual([soloStep.created, soloStep.matched, soloStep.remaining], [6, 0, 0]);

          // The same catalogue exported again (other bytes): rows matching an earlier file's
          // medicine by old code, or by name and pack size, create no second copy.
          const again2 = (await stage('solo', 'solo-products-reexport.csv', soloReexport)).batchId;
          assert.notEqual(again2, soloBatch);
          const reexportRequest = (await solo.createStagedMedicines({ batchId: again2 })) as {
            id: string;
          };
          await solo.decideCatalogueEdit({
            editId: reexportRequest.id,
            decision: 'APPROVE',
            soloPin: '2468',
          });
          const reexport = await solo.runStagedMedicineCreation({ batchId: again2 });
          assert.deepEqual(
            [reexport.created, reexport.matched, reexport.matchedEarlier, reexport.remaining],
            [2, 5, 5, 0]
          );
          assert.deepEqual(
            (await solodb.medicine.findMany({ orderBy: { productName: 'asc' } }))
              .map((item) => item.productName)
              .sort(),
            [
              'Solo Coded Tablet',
              'Solo Codeless Syrup',
              'Solo Name Only',
              'Solo Name Only',
              'Solo New Item',
              'Solo Other Capsule',
              'Solo Strength Tab',
              'Solo Strength Tab',
            ]
          );
          // Each strength of the re-export is linked to the medicine of that strength: 0 merged.
          const strengthRows = await solodb.pharmacyMigrationRow.findMany({
            where: { batchId: again2, productName: 'Solo Strength Tab' },
          });
          const strengthLinks = await solodb.pharmacyStagedMedicineLink.findMany({
            where: { sourceKey: { in: strengthRows.map((item) => item.sourceKey) } },
          });
          assert.equal(strengthLinks.length, 2);
          assert.equal(new Set(strengthLinks.map((item) => item.medicineId)).size, 2);
          for (const strengthRow of strengthRows) {
            const strengthLink = strengthLinks.find(
              (item) => item.sourceKey === strengthRow.sourceKey
            )!;
            assert.equal(strengthLink.outcome, 'MATCHED');
            const presentation = await solodb.presentation.findFirstOrThrow({
              where: { medicineId: strengthLink.medicineId! },
            });
            assert.equal(presentation.presentation, strengthRow.packLabel);
          }
          // A matched row's barcode is reported, and the existing medicine is not changed.
          const capsuleLink = await solodb.pharmacyStagedMedicineLink.findFirstOrThrow({
            where: { batchId: again2, barcode: MATCHED_BARCODE },
          });
          assert.deepEqual([capsuleLink.outcome, capsuleLink.barcodeAttached], ['MATCHED', false]);
          assert.equal(
            await solodb.medicineBarcode.count({ where: { normalizedCode: MATCHED_BARCODE } }),
            0
          );
          assert.equal(reexport.barcodesNotAttached, 1);

          // DEV-912 template, products only (no quantity column), with suppliers and reorder levels.
          for (const [key, name] of [
            ['sup_known', 'Solo Distributors'],
            ['sup_twin_1', 'Twin Traders'],
            ['sup_twin_2', 'twin  traders'],
          ])
            await c.query(
              `INSERT INTO pharmacy_suppliers (id,"organizationId",name,"updatedAt") VALUES ($1,$2,$3,now())`,
              [id(key), id('solo'), name]
            );
          const suppliersBefore = await solodb.pharmacySupplier.count();
          const template = await stage('solo', 'solo-template.csv', soloTemplate);
          const templateBatch = await solodb.pharmacyMigrationBatch.findUniqueOrThrow({
            where: { id: template.batchId },
          });
          assert.deepEqual(
            [templateBatch.quantityUnit, templateBatch.quantityColumn],
            [null, null]
          );
          assert.equal(
            await solodb.pharmacyMigrationException.count({
              where: { batchId: template.batchId, bucket: 'UNIT_AMBIGUOUS' },
            }),
            0
          );
          // The owner holds stock control at the branch, so the reorder levels go there.
          const templateRequest = (await solo.createStagedMedicines({
            batchId: template.batchId,
            branchId: id('branch_solo'),
          })) as unknown as {
            id: string;
            changes: { json: { reorderBranchId: string; reorderBranch: string } };
          };
          assert.deepEqual(
            [
              templateRequest.changes.json.reorderBranchId,
              templateRequest.changes.json.reorderBranch,
            ],
            [id('branch_solo'), 'Main']
          );
          await solo.decideCatalogueEdit({
            editId: templateRequest.id,
            decision: 'APPROVE',
            soloPin: '2468',
          });
          const templateStep = await solo.runStagedMedicineCreation({ batchId: template.batchId });
          assert.deepEqual(
            [
              templateStep.created,
              templateStep.remaining,
              templateStep.suppliersNotMatched,
              templateStep.reorderLevelsNotApplied,
            ],
            [5, 0, 2, 1]
          );
          // No supplier is ever created by an import.
          assert.equal(await solodb.pharmacySupplier.count(), suppliersBefore);
          const templateLinks = new Map(
            (
              await solodb.pharmacyStagedMedicineLink.findMany({
                where: { batchId: template.batchId },
              })
            ).map((link) => [link.legacyCode ?? 'none', link])
          );
          const pick = (code: string) => {
            const link = templateLinks.get(code)!;
            return [
              link.supplierName,
              link.supplierId,
              link.reorderLevelPacks,
              link.reorderLevelApplied,
            ];
          };
          assert.deepEqual(pick('T-1'), ['solo DISTRIBUTORS', id('sup_known'), 20, true]);
          assert.deepEqual(pick('T-2'), ['Nobody Wholesale', null, 5, true]);
          // No units per pack: the level cannot be counted in units, so it is not set.
          assert.deepEqual(pick('T-3'), ['Solo Distributors', id('sup_known'), 7, false]);
          // Two suppliers whose names normalise alike: no match, reported.
          assert.deepEqual(pick('T-4'), ['Twin Traders', null, 3, true]);
          assert.deepEqual(pick('none'), [null, null, null, null]);
          const safety = await solodb.pharmacySafetyStock.findMany({
            where: {
              medicineId: { in: [...templateLinks.values()].map((link) => link.medicineId!) },
            },
            orderBy: { safetyStockUnits: 'desc' },
          });
          assert.deepEqual(
            safety.map((item) => [
              item.medicineId,
              item.branchId,
              item.safetyStockUnits,
              item.approvedByUserId,
            ]),
            [
              [templateLinks.get('T-1')!.medicineId, id('branch_solo'), 200, id('owner_solo')],
              [templateLinks.get('T-2')!.medicineId, id('branch_solo'), 50, id('owner_solo')],
              [templateLinks.get('T-4')!.medicineId, id('branch_solo'), 30, id('owner_solo')],
            ]
          );
          // The owner sees the purchase price on the medicine's own detail, with its supplier.
          const known = await solo.get({ id: templateLinks.get('T-1')!.medicineId! });
          assert.equal(known.purchasePriceVisible, true);
          assert.deepEqual(
            known.purchasePrice && [
              known.purchasePrice.purchasePriceMinor,
              known.purchasePrice.supplierName,
              known.purchasePrice.supplierMatched,
            ],
            [8_000, 'solo DISTRIBUTORS', true]
          );
          assert.equal(
            (await solo.get({ id: templateLinks.get('none')!.medicineId! })).purchasePrice,
            null
          );
        } finally {
          await c.end();
        }
      }
    );
  }
);
