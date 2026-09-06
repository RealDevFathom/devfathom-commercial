/**
 * Fresh-tenant acceptance journey. Every domain write goes through rendered UI.
 * Run only with the dedicated time-to-first-sale config against an explicitly
 * authorized, isolated SHARED staging candidate. No seed/SQL/request helpers.
 *
 * PHARMACY_FIRST_SALE_INPUT is an operator-owned JSON file matching JourneyInput.
 * References below must describe real staging evidence, not invented approvals.
 * The environment must already have a compatible Pharmacy package (including
 * HR/procurement), confirmed jurisdiction rules, uploads, invite acceptance and
 * a configured SHARED deployment host. This test cannot manufacture those.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, type Browser, type Locator, type Page } from '@playwright/test';

const attestedSteps = [
  'Organization type',
  'Legal business',
  'Launch jurisdiction',
  'Branches and locations',
  'Devices and documents',
  'Readiness and parallel run',
] as const;

type JourneyInput = {
  environment: 'ISOLATED_SHARED_STAGING';
  authorizationRef: string;
  sourceSha: string;
  deployedSha: string;
  packageLabel: string;
  emailDomain: string;
  colleaguePhone: string;
  legalName: string;
  branchAddress: string;
  branchCity: string;
  provinceLabel: string;
  regulatory: {
    effectiveFrom: string;
    premisesStorageDescription: string;
    licenceCategoryLabel: string;
    licenceNumber: string;
    licenceValidFrom: string;
    licenceValidTo: string;
    licenceEvidencePath: string;
    permittedScheduleLabels: string[];
    qualifiedPersonRegistration: string;
    qualifiedPersonValidFrom: string;
    qualifiedPersonValidTo: string;
    qualifiedPersonCoverageRosterRef: string;
  };
  supplier: {
    name: string;
    legalName: string;
    licenceType: string;
    licenceNumber: string;
    issuingAuthority: string;
    issuedAt: string;
    expiresAt: string;
    evidenceUri: string;
    verifiedEvidenceRef: string;
  };
  receipt: {
    supplierInvoiceRef: string;
    warrantyEvidenceRef: string;
    approvalNote: string;
  };
  attestations: Record<(typeof attestedSteps)[number], string>;
};

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Required runtime precondition: ${name}`);
  return value;
}

function stagingOrigin(name: string) {
  const url = new URL(requiredEnvironment(name));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    /localhost|\.local$|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
  )
    throw new Error(`${name} must be an explicit isolated HTTPS staging origin.`);
  return url.origin;
}

function input(): JourneyInput {
  const value: JourneyInput = JSON.parse(
    readFileSync(requiredEnvironment('PHARMACY_FIRST_SALE_INPUT'), 'utf8')
  );
  const requiredPaths = [
    'authorizationRef',
    'sourceSha',
    'deployedSha',
    'packageLabel',
    'emailDomain',
    'colleaguePhone',
    'legalName',
    'branchAddress',
    'branchCity',
    'provinceLabel',
    'regulatory.effectiveFrom',
    'regulatory.premisesStorageDescription',
    'regulatory.licenceCategoryLabel',
    'regulatory.licenceNumber',
    'regulatory.licenceValidFrom',
    'regulatory.licenceValidTo',
    'regulatory.licenceEvidencePath',
    'regulatory.qualifiedPersonRegistration',
    'regulatory.qualifiedPersonValidFrom',
    'regulatory.qualifiedPersonValidTo',
    'regulatory.qualifiedPersonCoverageRosterRef',
    'supplier.name',
    'supplier.legalName',
    'supplier.licenceType',
    'supplier.licenceNumber',
    'supplier.issuingAuthority',
    'supplier.issuedAt',
    'supplier.expiresAt',
    'supplier.evidenceUri',
    'supplier.verifiedEvidenceRef',
    'receipt.supplierInvoiceRef',
    'receipt.warrantyEvidenceRef',
    'receipt.approvalNote',
  ];
  for (const path of requiredPaths) {
    const field = path
      .split('.')
      .reduce<unknown>(
        (node, key) => (node && typeof node === 'object' ? Reflect.get(node, key) : undefined),
        value
      );
    if (typeof field !== 'string' || !field.trim())
      throw new Error(`Missing runtime input: ${path}`);
  }
  if (
    !Array.isArray(value.regulatory.permittedScheduleLabels) ||
    !value.regulatory.permittedScheduleLabels.every(
      (item) => typeof item === 'string' && item.trim()
    )
  )
    throw new Error('Supply the permitted schedule labels from the confirmed jurisdiction.');
  // Validate without echoing credentials, evidence contents or business details.
  function nonempty(node: unknown): boolean {
    if (typeof node === 'string') return node.trim().length > 0;
    if (Array.isArray(node)) return node.length > 0 && node.every(nonempty);
    return Boolean(
      node &&
      typeof node === 'object' &&
      Object.values(node).length &&
      Object.values(node).every(nonempty)
    );
  }
  if (!nonempty(value) || value.environment !== 'ISOLATED_SHARED_STAGING')
    throw new Error('Provide complete, authorized staging journey inputs.');
  if (!/^[a-f0-9]{40}$/.test(value.sourceSha) || value.sourceSha !== value.deployedSha)
    throw new Error(
      'Operator must verify and supply matching exact source/deployed candidate SHAs.'
    );
  for (const step of attestedSteps)
    if (!value.attestations?.[step]?.trim())
      throw new Error(`Missing actual evidence for ${step}.`);
  // Fail before organization creation if the actual upload evidence is absent.
  readFileSync(value.regulatory.licenceEvidencePath);
  return value;
}

async function choose(select: Locator, label: string) {
  const option = select.getByRole('option').filter({ hasText: label });
  await expect(option).toHaveCount(1);
  await select.selectOption({ label: (await option.textContent())!.trim() });
}

async function fill(form: Locator | Page, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values))
    await form.locator(`[name="${name}"]`).fill(value);
}

async function noRawIdEntry(page: Page) {
  // Native selects may carry opaque values; the operator chooses readable labels.
  // Batch ID is a user-defined import reference, not a database row identifier.
  const names = await page
    .locator('input:visible:not([readonly]), textarea:visible')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const control = element as HTMLInputElement;
        return [
          control.name,
          control.getAttribute('aria-label'),
          ...Array.from(control.labels ?? [], (label) => label.textContent),
        ].join(' ');
      })
    );
  expect(
    names.filter((name) =>
      /(?:organization|branch|staff|device|medicine|presentation|packLevel|supplier|user|sale)[ _-]?id\b/i.test(
        name
      )
    )
  ).toEqual([]);
}

export async function freshPharmacyFirstSale(
  page: Page,
  browser: Browser,
  metric: { clicks: number },
  fourXx: string[]
) {
  const data = input();
  const platformOrigin = stagingOrigin('PLAYWRIGHT_BASE_URL');
  const tenantOrigin = stagingOrigin('PLAYWRIGHT_SHARED_BASE_URL');
  if (platformOrigin === tenantOrigin)
    throw new Error('Configure separate control and SHARED tenant origins.');
  const platformEmail = requiredEnvironment('PLAYWRIGHT_PLATFORM_ADMIN_EMAIL');
  const platformPassword = requiredEnvironment('PLAYWRIGHT_PLATFORM_ADMIN_PASSWORD');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const slug = `e2e-first-sale-${suffix}`;
  const ownerEmail = `owner-${suffix}@${data.emailDomain}`;
  const colleagueEmail = `approver-${suffix}@${data.emailDomain}`;
  const ownerPassword = `Wha1203!${randomUUID()}`;
  const colleaguePassword = `Wha1203!${randomUUID()}`;
  const branchName = `Test branch ${suffix}`;
  const medicineName = `Synthetic OTC ${suffix}`;
  const barcode = `TEST${suffix}`;
  const today = new Date().toISOString().slice(0, 10);
  const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const orderReference = `PO-${suffix}`;
  const click = async (target: Locator) => {
    metric.clicks += 1;
    await target.click();
  };
  const setup = async (actor: Page) => {
    await click(actor.getByRole('link', { name: 'Onboarding', exact: true }));
    await expect(actor).toHaveURL(new URL('/pharmacy', tenantOrigin).href);
    await expect(actor.locator('[data-slot="readiness-checklist"]')).toBeVisible();
    await noRawIdEntry(actor);
  };
  const row = (actor: Page, label: string) =>
    actor
      .locator('[data-slot="readiness-checklist"]')
      .getByRole('listitem')
      .filter({ hasText: label });
  const follow = async (actor: Page, gate: string, link: string) => {
    await click(row(actor, gate).getByRole('link', { name: link, exact: true }));
    await noRawIdEntry(actor);
  };
  const formFor = (actor: Page, submit: string) =>
    actor.locator('form').filter({ has: actor.getByRole('button', { name: submit, exact: true }) });
  const observe = (actor: Page) =>
    actor.on('response', (response) => {
      if (response.status() >= 400 && response.status() < 500)
        fourXx.push(
          `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname.replace(/\/invite\/[^/]+/, '/invite/[redacted]')}`
        );
    });
  const platformContext = await browser.newContext();
  const colleagueContext = await browser.newContext();
  const platform = await platformContext.newPage();
  const colleague = await colleagueContext.newPage();
  observe(platform);
  observe(colleague);
  try {
    await platform.goto(new URL('/platform/login', platformOrigin).href);
    await fill(platform, { email: platformEmail, password: platformPassword });
    await click(platform.getByRole('button', { name: 'Continue to control desk' }));
    await expect(platform).not.toHaveURL(/\/platform\/login/);
    await platform.goto(new URL('/platform/organizations/new', platformOrigin).href);
    await click(platform.getByRole('link', { name: /Continue as Pharmacy/ }));
    const create = formFor(platform, 'Create onboarding record');
    await fill(create, {
      displayName: `First sale ${suffix}`,
      legalName: data.legalName,
      slug,
      seatLimit: '5',
      currency: 'PKR',
      firstBranchName: branchName,
      firstBranchAddress: data.branchAddress,
      firstBranchCity: data.branchCity,
      primaryContactName: 'Test owner',
      primaryContactEmail: ownerEmail,
      adminName: 'Test owner',
      adminEmail: ownerEmail,
      adminPassword: ownerPassword,
    });
    await choose(create.locator('[name="deploymentMode"]'), 'Shared platform');
    await choose(create.locator('[name="packageId"]'), data.packageLabel);
    await choose(create.locator('[name="firstBranchProvinceCode"]'), data.provinceLabel);
    await click(create.getByRole('button', { name: 'Create onboarding record' }));
    await expect(platform).toHaveURL(/\/platform\/organizations\/(?!new)[^/?]+$/);
    const organizationUrl = platform.url();
    await expect(
      platform.locator('[data-slot="page-header"]').getByText('ONBOARDING', { exact: true })
    ).toBeVisible();

    await page.goto(new URL('/login', tenantOrigin).href);
    await fill(page, { email: ownerEmail, password: ownerPassword });
    await click(page.getByRole('button', { name: 'Sign in', exact: true }));
    await expect(page).not.toHaveURL(/\/login/);
    await setup(page);
    await expect(row(page, 'Commercial package').getByText('Done', { exact: true })).toBeVisible();
    await expect(
      row(page, 'Owner and role templates').getByText('Done', { exact: true })
    ).toBeVisible();

    await follow(page, 'Branches and locations', 'Create or review stock locations');
    const location = formFor(page, 'Create location');
    await fill(location, { name: 'Opening stock store', code: 'OPENING' });
    await choose(location.locator('[name="kind"]'), 'Store');
    await click(location.getByRole('button', { name: 'Create location' }));
    await expect(page.getByText('Opening stock store', { exact: true }).first()).toBeVisible();
    await setup(page);

    await follow(page, 'Premises and licences', 'Open regulatory profile');
    await choose(page.getByLabel('Which branch is this profile for?'), branchName);
    await choose(page.getByLabel('Province', { exact: true }), data.provinceLabel);
    await choose(
      page.getByLabel('Licence category', { exact: true }),
      data.regulatory.licenceCategoryLabel
    );
    const { licenceEvidencePath, permittedScheduleLabels } = data.regulatory;
    await fill(page, {
      effectiveFrom: data.regulatory.effectiveFrom,
      premisesStorageDescription: data.regulatory.premisesStorageDescription,
      licenceNumber: data.regulatory.licenceNumber,
      licenceValidFrom: data.regulatory.licenceValidFrom,
      licenceValidTo: data.regulatory.licenceValidTo,
      qualifiedPersonRegistration: data.regulatory.qualifiedPersonRegistration,
      qualifiedPersonValidFrom: data.regulatory.qualifiedPersonValidFrom,
      qualifiedPersonValidTo: data.regulatory.qualifiedPersonValidTo,
      qualifiedPersonCoverageRosterRef: data.regulatory.qualifiedPersonCoverageRosterRef,
    });
    await page.locator('#licenceEvidence').setInputFiles(licenceEvidencePath);
    await expect(page.getByText('Licence evidence attached', { exact: false })).toBeVisible();
    for (const schedule of permittedScheduleLabels)
      await page.getByRole('checkbox', { name: schedule, exact: true }).check();
    await click(page.getByRole('button', { name: 'Save this version', exact: true }));
    await expect(page.getByText('Version 1 saved.', { exact: false })).toBeVisible();
    await setup(page);
    await expect(
      row(page, 'Premises and licences').getByText('Done', { exact: true })
    ).toBeVisible();

    await follow(page, 'Medicine catalog readiness', 'Set up medicines and packs');
    const headers =
      'productName,brandName,manufacturer,drapRegistrationNumber,strength,dosageForm,pack,barcode,alias,rx,restricted,controlled,rowSourceKey';
    const values = [
      medicineName,
      'Synthetic test brand',
      'Synthetic test maker',
      `TEST-${suffix}`,
      '500 mg',
      'Tablet',
      '10 tablets',
      barcode,
      `Synthetic alias ${suffix}`,
      'false',
      'false',
      'false',
      `row-${suffix}`,
    ];
    await page.getByLabel('CSV or Excel workbook').setInputFiles({
      name: `synthetic-${suffix}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(`${headers}\n${values.join(',')}\n`),
    });
    await click(page.getByRole('button', { name: 'Preview normalized rows', exact: true }));
    await click(page.getByRole('button', { name: 'Run 1 rows now', exact: true }));
    const candidate = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: medicineName, exact: true }) });
    await click(candidate.getByRole('button', { name: 'accept', exact: true }));
    await click(candidate.getByRole('button', { name: 'Publish assertions', exact: true }));
    await expect(candidate).toHaveCount(0);
    await page.getByLabel('Medicine name', { exact: true }).fill(medicineName);
    await click(page.getByRole('button', { name: 'Find medicine', exact: true }));
    await choose(page.getByLabel('Medicine', { exact: true }), medicineName);
    await choose(page.getByLabel('Presentation', { exact: true }), '10 tablets');
    await choose(page.getByLabel('Pack type', { exact: true }), 'Strip');
    await page.getByLabel(/^Individual units per pack/).fill('10');
    await page.getByLabel(/^Effective from/).fill(today);
    await click(page.getByRole('button', { name: 'Create pack', exact: true }));
    await expect(page.getByText('Pack created', { exact: false })).toBeVisible();
    await setup(page);
    await expect(
      row(page, 'Medicine catalog readiness').getByText('Done', { exact: true })
    ).toBeVisible();

    await follow(page, 'Parties and balances', 'Set up suppliers');
    const supplier = formFor(page, 'Add supplier');
    await fill(supplier, { name: data.supplier.name, legalName: data.supplier.legalName });
    await click(supplier.getByRole('button', { name: 'Add supplier', exact: true }));
    await click(page.getByRole('button', { name: 'Authorize this supplier', exact: true }));
    const licence = formFor(page, 'File licence');
    await fill(licence, {
      licenceType: data.supplier.licenceType,
      licenceNumber: data.supplier.licenceNumber,
      issuingAuthority: data.supplier.issuingAuthority,
      issuedAt: data.supplier.issuedAt,
      expiresAt: data.supplier.expiresAt,
      evidenceUri: data.supplier.evidenceUri,
    });
    await licence
      .getByRole('checkbox', { name: 'I have checked this licence against the issuing authority' })
      .check();
    await click(licence.getByRole('button', { name: 'File licence', exact: true }));
    await expect(page.getByText('Licence filed.', { exact: false })).toBeVisible();
    await setup(page);

    await follow(page, 'Opening stock readiness', 'Receive opening stock');
    await click(page.getByRole('link', { name: 'Invite a colleague', exact: true }));
    await click(page.getByRole('button', { name: 'Add Member', exact: true }));
    await page.getByPlaceholder('John Doe', { exact: true }).fill('Test second approver');
    await page.getByPlaceholder('john@company.com', { exact: true }).fill(colleagueEmail);
    await page
      .getByPlaceholder('Full Stack Developer', { exact: true })
      .fill('Purchasing reviewer');
    await choose(page.getByLabel('Department', { exact: true }), 'Counter');
    await click(page.getByRole('button', { name: 'Admin', exact: true }));
    await click(page.getByRole('button', { name: 'Send Invite', exact: true }));
    const invitation = page
      .getByText('Invite link', { exact: true })
      .locator('..')
      .locator('p')
      .last();
    await expect(invitation).toBeVisible();
    const inviteUrl = new URL((await invitation.textContent())!.trim());
    if (inviteUrl.origin !== tenantOrigin || !inviteUrl.pathname.startsWith('/invite/'))
      throw new Error('Invitation must target the configured isolated SHARED tenant host.');
    await colleague.goto(inviteUrl.href);
    await colleague.locator('#password').fill(colleaguePassword);
    await colleague.locator('#confirm').fill(colleaguePassword);
    await colleague.locator('#phone').fill(data.colleaguePhone);
    await click(colleague.getByRole('button', { name: 'Create account', exact: true }));
    await expect(colleague).not.toHaveURL(/\/invite\//);
    await setup(colleague);
    await click(page.getByRole('button', { name: 'Done', exact: true }));
    await setup(page);

    await follow(page, 'Opening stock readiness', 'Receive opening stock');
    await click(page.getByRole('link', { name: 'Requisitions & orders', exact: true }));
    const order = formFor(page, 'Draft order');
    await fill(order, { reference: orderReference, 'orderedPacks-0': '2', 'listPrice-0': '20.00' });
    await choose(order.locator('[name="supplierId"]'), data.supplier.name);
    await choose(order.locator('[name="branchId"]'), branchName);
    await choose(order.locator('[name="orderMedicineId-0"]'), medicineName);
    await click(order.getByRole('button', { name: 'Draft order', exact: true }));
    await click(page.getByRole('button', { name: 'Submit for approval', exact: true }));
    await expect(
      page.getByText('You raised this order, so you cannot approve it.', { exact: false })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await follow(colleague, 'Opening stock readiness', 'Receive opening stock');
    await click(colleague.getByRole('link', { name: 'Requisitions & orders', exact: true }));
    await click(colleague.getByRole('link').filter({ hasText: orderReference }));
    await colleague.getByLabel('Decision note', { exact: true }).fill(data.receipt.approvalNote);
    await click(colleague.getByRole('button', { name: 'Approve', exact: true }));
    await click(colleague.getByRole('button', { name: 'Send to supplier', exact: true }));
    await expect(
      colleague.getByRole('link', { name: 'Receive against this order', exact: true })
    ).toBeVisible();

    await setup(page);
    await follow(page, 'Opening stock readiness', 'Receive opening stock');
    await choose(page.getByLabel('Purchase order', { exact: true }), orderReference);
    await click(page.getByRole('button', { name: 'Find line', exact: true }));
    const receipt = formFor(page, 'File receipt (draft)');
    await fill(receipt, {
      reference: `GR-${suffix}`,
      supplierInvoiceRef: data.receipt.supplierInvoiceRef,
      warrantyEvidenceRef: data.receipt.warrantyEvidenceRef,
    });
    await receipt.getByLabel('Batch number', { exact: true }).fill(`B-${suffix}`);
    await receipt.getByLabel('Printed expiry', { exact: true }).fill(expiry);
    await receipt.getByLabel('Printed MRP (PKR)', { exact: true }).fill('25.00');
    await receipt.getByLabel('Packs received', { exact: true }).fill('2');
    await choose(receipt.getByLabel('Receive into', { exact: true }), 'Opening stock store');
    await click(receipt.getByRole('button', { name: 'File receipt (draft)', exact: true }));
    await click(page.getByRole('button', { name: 'Post into stock', exact: true }));
    await setup(page);
    await expect(
      row(page, 'Opening stock readiness').getByText('Done', { exact: true })
    ).toBeVisible();

    // These are supplied real staging evidence references, never fabricated ticks.
    for (const step of attestedSteps) {
      const gate = row(page, step);
      await click(gate.getByRole('button', { name: 'Confirm this step', exact: true }));
      await gate
        .getByLabel('Where is the evidence recorded?', { exact: true })
        .fill(data.attestations[step]);
      await click(gate.getByRole('button', { name: 'Mark as done', exact: true }));
      await expect(gate.getByText('Done', { exact: true })).toBeVisible();
    }
    await expect(
      page.locator('[data-slot="readiness-checklist"]').getByText('Done', { exact: true })
    ).toHaveCount(12);
    // Reuse the shipped control-plane action when the SHARED default is still
    // pending. It resolves the configured tenant host; no invented deployment.
    await platform.goto(organizationUrl);
    const shared = platform.getByRole('button', { name: 'Use shared deployment', exact: true });
    if (await shared.isVisible()) await click(shared);
    await expect(platform.getByText('Unmet activation gates', { exact: true })).toHaveCount(0);
    const lifecycle = formFor(platform, 'Apply lifecycle change');
    await choose(lifecycle.getByLabel('Move to', { exact: true }), 'ACTIVE');
    await lifecycle.getByLabel('Operator reason', { exact: true }).fill(data.authorizationRef);
    await click(lifecycle.getByRole('button', { name: 'Apply lifecycle change', exact: true }));
    await expect(
      platform.locator('[data-slot="page-header"]').getByText('ACTIVE', { exact: true })
    ).toBeVisible();

    await follow(page, 'Readiness and parallel run', 'Open pharmacy counter');
    await click(page.getByRole('button', { name: 'Open drawer', exact: true }));
    await page.getByLabel('Scan or search', { exact: true }).fill(barcode);
    await page.getByLabel('Scan or search', { exact: true }).press('Enter');
    await click(
      page
        .getByRole('list', { name: 'Search results' })
        .getByRole('button')
        .filter({ hasText: medicineName })
    );
    await page.keyboard.press('F4');
    await page.keyboard.press('F6');
    await page.keyboard.press('F9');
    const amount = page.getByLabel('Amount', { exact: true });
    await expect(amount).toBeEnabled();
    const due = await amount.getAttribute('placeholder');
    expect(due).toMatch(/^\d+\.\d{2}$/);
    expect(Number(due)).toBeGreaterThan(0);
    await amount.fill(due!);
    await page.getByLabel('Cash received', { exact: true }).fill(due!);
    await click(page.getByRole('button', { name: 'Take payment', exact: true }));
    await expect(page.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible();
    await noRawIdEntry(page);
    expect(fourXx).toEqual([]);
  } finally {
    await colleagueContext.close();
    await platformContext.close();
  }
}
