import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PHARMACY_PACKAGES, PHARMACY_ROLE_TEMPLATES } from '../../src/lib/vertical-catalog';
import {
  controlPlaneEnvironmentAvailable,
  loginPlatform,
  platformMutationHeaders,
  resetOrganization,
  withAdminDatabase,
} from './fixtures/platform-control-plane';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });
test.skip(
  !controlPlaneEnvironmentAvailable(),
  'Requires a fresh test/e2e PostgreSQL database, restricted DATABASE_URL, admin setup URL, and seeded platform admin email/password.'
);

const pharmacy = {
  slug: 'e2e-pharmacy-control-plane',
  email: 'pharmacy-owner@e2e.invalid',
  password: 'Local-only-pharmacy-42!',
};

const pharmacyPackageIds = new Map<string, string>();
const execFileAsync = promisify(execFile);

test.beforeAll(async () => {
  const adminUrl = process.env.PLAYWRIGHT_DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('PLAYWRIGHT_DATABASE_ADMIN_URL is required.');
  await execFileAsync('bun', ['prisma/sync-catalog.ts'], {
    env: { ...process.env, DATABASE_URL: adminUrl },
  });

  await withAdminDatabase(async (db) => {
    for (const [index, plan] of PHARMACY_PACKAGES.entries()) {
      const result = await db.query<{ id: string }>(
        `UPDATE platform_packages SET active=true, "defaultSeats"=$2, "updatedAt"=now()
         WHERE key=$1 AND vertical='PHARMACY' RETURNING id`,
        [plan.key, index === 0 ? 10 : index === 1 ? 50 : 2500]
      );
      expect(result.rows).toHaveLength(1);
      pharmacyPackageIds.set(plan.key, result.rows[0]!.id);
    }
    await db.query(
      `INSERT INTO platform_packages (id,key,name,vertical,version,active,"defaultSeats","createdAt","updatedAt")
       VALUES ('e2e_cross_vertical_package','e2e-cross-vertical-package','E2E Agency Only','AGENCY',1,true,5,now(),now())
       ON CONFLICT (key) DO UPDATE SET vertical='AGENCY', active=true, "updatedAt"=now()`
    );
  });
  await resetOrganization(pharmacy.slug);
});

test('SuperAdmin completes the audited PHARMACY lifecycle and cross-vertical requests fail closed', async ({
  page,
}) => {
  await loginPlatform(page);
  await page.goto('/platform/organizations/new');
  await page.getByRole('link', { name: /Continue as Pharmacy/ }).click();

  const packageSelect = page.locator('select[name="packageId"]');
  const packageLabels = await withAdminDatabase(async (db) => {
    const catalog = await db.query<{ name: string; defaultSeats: number }>(
      `SELECT name, "defaultSeats" FROM platform_packages WHERE active AND vertical='PHARMACY' ORDER BY name`
    );
    return catalog.rows.map((row) => `${row.name} · ${row.defaultSeats} default seats`);
  });
  expect(packageLabels.length).toBeGreaterThanOrEqual(3);
  await expect(packageSelect.locator('option')).toHaveText(packageLabels);
  await expect(packageSelect.locator('option')).not.toContainText(['E2E Agency Only']);

  await page.getByLabel('Display name').fill('E2E Pharmacy');
  await page.getByLabel('Legal name').fill('E2E Pharmacy (Private) Limited');
  await page.getByLabel('Workspace slug').fill(pharmacy.slug);
  await page.getByLabel('First branch name').fill('Clifton Chemist');
  await page.getByLabel('First branch address').fill('12 Clifton Road, Karachi');
  await page.getByLabel('First branch city').fill('Karachi');
  await packageSelect.selectOption(pharmacyPackageIds.get('pharmacy-essentials')!);
  await page.getByLabel('Primary contact', { exact: true }).fill('Pharmacy Owner');
  await page.getByLabel('Primary contact email').fill(pharmacy.email);
  await page.getByLabel('Tenant administrator').fill('Pharmacy Owner');
  await page.getByLabel('Administrator email').fill(pharmacy.email);
  await page.getByLabel('Temporary administrator password').fill(pharmacy.password);
  await page.getByRole('button', { name: 'Create onboarding record' }).click();
  await expect(page).toHaveURL(/\/platform\/organizations\/(?!new(?:[/?]|$))[^/?]+/);

  const organizationId = await withAdminDatabase(async (db) => {
    const result = await db.query<{ id: string }>(`SELECT id FROM organizations WHERE slug=$1`, [
      pharmacy.slug,
    ]);
    expect(result.rows).toHaveLength(1);
    await db.query(
      `UPDATE organization_deployments SET status='READY'
       WHERE "organizationId"=$1 AND environment='production'`,
      [result.rows[0]!.id]
    );
    return result.rows[0]!.id;
  });

  const crafted = await page.request.post('/api/platform/control', {
    headers: platformMutationHeaders,
    data: {
      action: 'organization.update',
      payload: { id: organizationId, packageId: 'e2e_cross_vertical_package' },
    },
    failOnStatusCode: false,
  });
  expect(crafted.status()).toBe(400);
  await expect(crafted.json()).resolves.toMatchObject({
    error: 'The selected package is not available for the PHARMACY vertical.',
  });

  await seedProvisionalProfile(organizationId);
  expect(
    (await transition(page, 'ACTIVE', 'E2E activation refused on provisional PK-PB rules')).status()
  ).toBe(400);
  await expect(page.getByText(/RULE_SET_UNCONFIRMED/)).toBeVisible();
  await expect(page.getByText('ONBOARDING', { exact: true }).first()).toBeVisible();

  await seedMinimalReadiness(organizationId);
  await page.reload();
  const activation = await transition(
    page,
    'ACTIVE',
    'E2E activation after all pharmacy readiness gates passed'
  );
  expect(await activation.json()).toMatchObject({ data: { status: 'ACTIVE' } });
  await expect(page.locator('[data-slot="status-pill"]').first()).toHaveText('ACTIVE');

  await packageSelectOnProfile(page, pharmacyPackageIds.get('pharmacy-professional')!);
  // The successful profile command revalidates this server-rendered page. Wait
  // for a settled detail document before interacting with the independent
  // lifecycle form, otherwise its first target (GRACE) can replace the chosen
  // option while the client applies the profile response.
  await page.reload();
  expect((await transition(page, 'SUSPENDED', 'E2E pharmacy lifecycle suspension')).status()).toBe(
    200
  );
  await expect(page.locator('[data-slot="status-pill"]').first()).toHaveText('SUSPENDED');
  expect((await transition(page, 'ACTIVE', 'E2E pharmacy lifecycle reactivation')).status()).toBe(
    200
  );
  await expect(page.locator('[data-slot="status-pill"]').first()).toHaveText('ACTIVE');

  await withAdminDatabase(async (db) => {
    const organization = await db.query(
      `SELECT o.status,p.key AS package_key FROM organizations o JOIN platform_packages p ON p.id=o."packageId" WHERE o.id=$1`,
      [organizationId]
    );
    expect(organization.rows).toEqual([{ status: 'ACTIVE', package_key: 'pharmacy-professional' }]);
    const lifecycle = await db.query(
      `SELECT action,"fromStatus","toStatus" FROM organization_lifecycle_events WHERE "organizationId"=$1 ORDER BY "createdAt"`,
      [organizationId]
    );
    expect(lifecycle.rows.map((row) => row.action)).toEqual([
      'CREATED',
      'ACTIVATED',
      'SUSPENDED',
      'RESUMED',
    ]);
    const regulatoryProfiles = await db.query(
      `SELECT version,"jurisdictionRuleSetId","effectiveFrom","effectiveTo"
       FROM pharmacy_branch_regulatory_profiles
       WHERE "organizationId"=$1 AND "branchId"=(SELECT id FROM pharmacy_branches WHERE "organizationId"=$1 AND code='MAIN')
       ORDER BY version`,
      [organizationId]
    );
    expect(regulatoryProfiles.rows).toMatchObject([
      {
        version: 1,
        jurisdictionRuleSetId: 'pk_pb_provisional_v1',
        effectiveTo: new Date('2026-09-02T01:00:00.000Z'),
      },
      {
        version: 2,
        jurisdictionRuleSetId: 'e2e_pk_pb_confirmed',
        effectiveFrom: new Date('2026-09-02T01:00:00.000Z'),
        effectiveTo: null,
      },
    ]);
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM platform_audit_logs WHERE "organizationId"=$1 AND action IN ('organization.create','organization.update','organization.transition') ORDER BY "createdAt"`,
      [organizationId]
    );
    expect(audit.rows.filter((row) => row.action === 'organization.create')).toHaveLength(1);
    expect(
      audit.rows.filter((row) => row.action === 'organization.update').length
    ).toBeGreaterThanOrEqual(1);
    expect(audit.rows.filter((row) => row.action === 'organization.transition')).toHaveLength(3);
  });
});

async function transition(page: import('@playwright/test').Page, status: string, reason: string) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith('/api/platform/control') && candidate.request().method() === 'POST'
  );
  await page.getByLabel('Move to').selectOption(status);
  await page.locator('#lifecycle').getByLabel('Operator reason').fill(reason);
  await page.getByRole('button', { name: 'Apply lifecycle change' }).click();
  return response;
}

async function packageSelectOnProfile(page: import('@playwright/test').Page, packageId: string) {
  const profile = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Workspace profile' }) });
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith('/api/platform/control') && candidate.request().method() === 'POST'
  );
  await profile.locator('select[name="packageId"]').selectOption(packageId);
  await profile.getByRole('button', { name: 'Save changes' }).click();
  expect((await response).status()).toBe(200);
}

let pharmacyBranchId: string;

async function seedProvisionalProfile(organizationId: string) {
  await withAdminDatabase(async (db) => {
    const branches = await db.query<{ id: string }>(
      `SELECT id FROM pharmacy_branches WHERE "organizationId"=$1 AND code='MAIN'`,
      [organizationId]
    );
    expect(branches.rows).toHaveLength(1);
    pharmacyBranchId = branches.rows[0]!.id;
    await db.query(
      `INSERT INTO pharmacy_branch_regulatory_profiles
       (id,"organizationId","branchId",version,"effectiveFrom","provinceCode","jurisdictionRuleSetId",premises,"licenceCategory","licenceNumber","licenceValidFrom","licenceValidTo","licenceEvidenceFileRef","permittedSchedules","qualifiedPersonRegistration","qualifiedPersonValidFrom","qualifiedPersonValidTo","qualifiedPersonCoverageRosterRef","fiscalStatus","retentionPolicy")
       VALUES ('e2e_pharmacy_profile_provisional',$1,$2,1,'2026-09-02T00:00:00.000Z','PK-PB','pk_pb_provisional_v1','{}','PHARMACY','PB-E2E-1',now()-interval '1 day',now()+interval '1 year','evidence://licence',ARRAY['RX'],'QP-E2E-1',now()-interval '1 day',now()+interval '1 year','evidence://roster','REGISTERED','{}')`,
      [organizationId, pharmacyBranchId]
    );
  });
}

async function seedMinimalReadiness(organizationId: string) {
  await withAdminDatabase(async (db) => {
    for (const role of PHARMACY_ROLE_TEMPLATES) {
      await db.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt")
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT ("organizationId",key) DO UPDATE SET name=EXCLUDED.name,"isSystem"=EXCLUDED."isSystem","updatedAt"=now()`,
        [`e2e_pharmacy_role_${role.key}`, organizationId, role.key, role.name, role.isSystem]
      );
    }
    await db.query(
      `UPDATE pharmacy_branch_regulatory_profiles SET "effectiveTo"='2026-09-02T01:00:00.000Z' WHERE id='e2e_pharmacy_profile_provisional'`
    );
    await db.query(
      `UPDATE pharmacy_jurisdiction_rule_sets SET "effectiveTo"='2026-09-02T01:00:00.000Z' WHERE id='pk_pb_provisional_v1'`
    );
    await db.query(
      `INSERT INTO pharmacy_jurisdiction_rule_sets
       (id,code,version,"effectiveFrom","licenceCategories","permittedSchedules","prescriptionOnlyClasses","prescriptionRetentionDays","controlledRegisterFlags","pharmacistCoverageRule","recordRetentionByClass")
       VALUES ('e2e_pk_pb_confirmed','PK-PB',2,'2026-09-02T01:00:00.000Z','{"provisional":false,"values":["PHARMACY"]}','{"provisional":false,"values":["RX"]}','{"provisional":false,"values":[]}','{"provisional":false,"values":{}}','{"provisional":false,"values":{}}','{"provisional":false,"values":{}}','{"provisional":false,"values":{}}')`
    );
    await db.query(
      `INSERT INTO pharmacy_branch_regulatory_profiles
       (id,"organizationId","branchId",version,"effectiveFrom","provinceCode","jurisdictionRuleSetId",premises,"licenceCategory","licenceNumber","licenceValidFrom","licenceValidTo","licenceEvidenceFileRef","permittedSchedules","qualifiedPersonRegistration","qualifiedPersonValidFrom","qualifiedPersonValidTo","qualifiedPersonCoverageRosterRef","fiscalStatus","retentionPolicy")
       VALUES ('e2e_pharmacy_profile_confirmed',$1,$2,2,'2026-09-02T01:00:00.000Z','PK-PB','e2e_pk_pb_confirmed','{}','PHARMACY','PB-E2E-1',now()-interval '1 day',now()+interval '1 year','evidence://licence',ARRAY['RX'],'QP-E2E-1',now()-interval '1 day',now()+interval '1 year','evidence://roster','REGISTERED','{}')`,
      [organizationId, pharmacyBranchId]
    );
    await db.query(
      `INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily",saleable,"updatedAt") VALUES ('e2e_medicine',$1,'E2E Medicine','PHARMACEUTICAL',true,now())`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_presentations (id,"organizationId","medicineId",presentation,"updatedAt") VALUES ('e2e_presentation',$1,'e2e_medicine','10 tablets',now())`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_pack_levels (id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom") VALUES ('e2e_pack',$1,'e2e_presentation','e2e-pack',1,'CARTON',10,now()-interval '1 day')`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_medicine_provenance (id,"organizationId","medicineId",field,source,"sourceType","retrievedAt",status,"assertedValue",reviewer) VALUES ('e2e_assertion',$1,'e2e_medicine','productName','E2E','USER',now(),'ACCEPTED','"E2E Medicine"','e2e_platform_admin')`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_medicine_publication_batches (id,"organizationId",status,"publishedBy","publishedAt") VALUES ('e2e_publication',$1,'PUBLISHED','e2e_platform_admin',now())`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_medicine_publication_entries (id,"organizationId","batchId","assertionId") VALUES ('e2e_publication_entry',$1,'e2e_publication','e2e_assertion')`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_manufacturing_batches (id,"organizationId","medicineId","batchNumber","expiresAt","updatedAt") VALUES ('e2e_batch',$1,'e2e_medicine','BATCH-1',now()+interval '1 year',now())`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_inventory_lots (id,"organizationId","branchId","manufacturingBatchId","packLevelId","unitsPerPack","supplierName","supplierInvoiceRef","unitCostMinor","printedMrpMinor","receivedExpiresAt","receivedExpiryPrecision","receivedAt","updatedAt") VALUES ('e2e_lot',$1,(SELECT id FROM pharmacy_branches WHERE "organizationId"=$1 AND code='MAIN'),'e2e_batch','e2e_pack',10,'E2E Supplier','INV-1',100,150,now()+interval '1 year','DAY',now(),now())`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_suppliers (id,"organizationId",name,authorized,active,"updatedAt") VALUES ('e2e_supplier',$1,'E2E Authorized Supplier',true,true,now())`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_onboarding_states (id,"organizationId","updatedAt") VALUES ('e2e_onboarding',$1,now())`,
      [organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_onboarding_gate_states (id,"organizationId",gate,status,"evidenceRef","branchId","actorId","recordedAt","updatedAt")
       SELECT 'e2e_gate_'||gate,$1,gate::"PharmacyOnboardingGate",'PASSED','evidence://'||gate,CASE WHEN gate IN ('PREMISES_AND_LICENCES','BRANCHES_AND_LOCATIONS') THEN (SELECT id FROM pharmacy_branches WHERE "organizationId"=$1 AND code='MAIN') END,'e2e_platform_admin',now(),now()
       FROM unnest(enum_range(NULL::"PharmacyOnboardingGate")::text[]) gate`,
      [organizationId]
    );
  });
}
