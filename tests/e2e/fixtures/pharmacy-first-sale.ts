import { resolvePharmacyE2eDatabaseUrl } from '../../../scripts/pharmacy-e2e-environment';
import { platformAuthentication } from './platform-control-plane';
/**
 * Fresh-tenant acceptance journey; business setup and the sale use rendered UI.
 * Staging uses operator-owned, real evidence in PHARMACY_FIRST_SALE_INPUT.
 * The counter lane prepares explicitly synthetic DISPOSABLE_E2E inputs instead,
 * admitted only with PHARMACY_E2E=1 and a disposable loopback database/origins.
 * Synthetic jurisdiction/evidence and the MFA fixture are never staging attestations.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

const attestedSteps = [
  'Organization type',
  'Legal business',
  'Launch jurisdiction',
  'Branches and locations',
  'Devices and documents',
  'Readiness and parallel run',
] as const;

type JourneyInput = {
  environment: 'ISOLATED_SHARED_STAGING' | 'DISPOSABLE_E2E';
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

function stagingOrigin(name: string, disposable = false) {
  if (disposable) {
    const database = new URL(resolvePharmacyE2eDatabaseUrl());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname))
      throw new Error('Synthetic journey requires loopback PostgreSQL.');
    const local = new URL(
      requiredEnvironment(
        name === 'PLAYWRIGHT_BASE_URL'
          ? 'PHARMACY_FIRST_SALE_PLATFORM_ORIGIN'
          : 'PHARMACY_FIRST_SALE_TENANT_ORIGIN'
      )
    );
    if (
      local.protocol !== 'http:' ||
      !['admin.localhost', 'www.localhost'].includes(local.hostname) ||
      !local.port ||
      local.username ||
      local.password ||
      local.pathname !== '/' ||
      local.search ||
      local.hash
    )
      throw new Error('Disposable journey requires explicit loopback origins.');
    return local.origin;
  }
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
  if (value.environment === 'DISPOSABLE_E2E') resolvePharmacyE2eDatabaseUrl();
  if (
    !nonempty(value) ||
    !['ISOLATED_SHARED_STAGING', 'DISPOSABLE_E2E'].includes(value.environment)
  )
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

/** Full accessible link name used by the shared readiness renderer. */
export function pharmacyChecklistLinkName(gate: string, link: string): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(link)}\\s*—\\s*${escape(gate)}$`);
}

export async function freshPharmacyFirstSale(
  page: Page,
  browser: Browser,
  metric: { clicks: number },
  fourXx: string[],
  testInfo: TestInfo
) {
  const data = input();
  const disposable = data.environment === 'DISPOSABLE_E2E';
  const platformOrigin = stagingOrigin('PLAYWRIGHT_BASE_URL', disposable);
  const tenantOrigin = stagingOrigin('PLAYWRIGHT_SHARED_BASE_URL', disposable);
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
  // Synthetic, and no easy pattern (DEV-931 refuses 1234, 1111 and the like).
  const ownerPin = '583917';
  const branchName = `Test branch ${suffix}`;
  const medicineName = `Synthetic OTC ${suffix}`;
  // Digits only: the counter treats a code of six or more digits as a scan (scan-to-add).
  const barcode = `8964${randomInt(100_000_000, 1_000_000_000)}`;
  const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const orderReference = `PO-${suffix}`;
  const click = async (target: Locator) => {
    metric.clicks += 1;
    await expect(target).toBeVisible();
    await expect(target).toBeEnabled();
    await target.click();
  };
  const setup = async (actor: Page) => {
    await click(actor.getByRole('link', { name: /Onboarding$/ }));
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
    const target = row(actor, gate).getByRole('link', {
      name: pharmacyChecklistLinkName(gate, link),
    });
    await expect(target).toHaveCount(1);
    await click(target);
    await noRawIdEntry(actor);
  };
  // DEV-46: the opening-stock checklist link now opens the importer; this journey
  // still opens supplier receiving, so it navigates there directly.
  const receiving = async (actor: Page) => {
    await actor.goto(new URL('/pharmacy/purchasing/receiving', tenantOrigin).href);
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
  // Each person signs in from their own device, as in a real pharmacy. The lane's other
  // specs sign in many times from one loopback address first, and the shared-host sign-in
  // limiter rightly counts that address as one client; the new owner's and the colleague's
  // browsers are other clients (synthetic TEST-NET-2 addresses; the lane trusts one proxy hop).
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': '198.51.100.91' });
  const platformContext = await browser.newContext();
  const colleagueContext = await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.92' },
  });
  const platform = await platformContext.newPage();
  const colleague = await colleagueContext.newPage();
  observe(platform);
  observe(colleague);
  try {
    await platform.goto(new URL('/platform/login', platformOrigin).href);
    await fill(
      platform,
      disposable
        ? await platformAuthentication({ email: platformEmail, password: platformPassword })
        : { email: platformEmail, password: platformPassword }
    );
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

    // Wildcard ownership deliberately cannot confirm regulated reference changes.
    // Grant this one review capability explicitly through the audited platform UI.
    const reviewGrant = formFor(platform, 'Set override');
    await choose(reviewGrant.locator('[name="userId"]'), ownerEmail);
    await fill(reviewGrant, {
      capability: 'pharmacy:catalogue-review',
      reason: data.authorizationRef,
      expiresAt: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
    });
    await choose(reviewGrant.locator('[name="effect"]'), 'ALLOW');
    const ownerUpdated = platform.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/platform/control' &&
        response.request().method() === 'POST'
    );
    await click(reviewGrant.getByRole('button', { name: 'Set override', exact: true }));
    expect((await ownerUpdated).status()).toBe(200);

    await page.goto(new URL('/login', tenantOrigin).href);
    const signInOwner = async (password: string) => {
      await fill(page, { email: ownerEmail, password });
      // Discovery and credential verification precede navigation.
      const authenticated = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.origin === tenantOrigin &&
          url.pathname === '/api/auth/callback/login-intent' &&
          response.request().method() === 'POST'
        );
      });
      await click(page.getByRole('button', { name: 'Sign in', exact: true }));
      expect((await authenticated).status()).toBe(200);
    };
    await signInOwner(ownerPassword);
    await expect(page).toHaveURL(/\/change-password(?:\?|$)/);
    const rotatedOwnerPassword = `FirstSale1!${randomUUID()}`;
    await page.getByLabel('Current password', { exact: true }).fill(ownerPassword);
    await page.getByLabel('New password', { exact: true }).fill(rotatedOwnerPassword);
    await page.getByLabel('Confirm new password', { exact: true }).fill(rotatedOwnerPassword);
    await click(page.getByRole('button', { name: 'Change password', exact: true }));
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    // Password rotation may return to the runtime's canonical host. Resume
    // workspace discovery on this journey's explicit shared origin.
    await page.goto(new URL('/login', tenantOrigin).href);
    await signInOwner(rotatedOwnerPassword);
    await expect(page).not.toHaveURL(/\/login/);
    await setup(page);
    await expect(row(page, 'Commercial package').getByText('Done', { exact: true })).toBeVisible();
    await expect(
      row(page, 'Owner and role templates').getByText('Done', { exact: true })
    ).toBeVisible();

    // DEV-931: onboarding asks the new owner to create his own PIN before the first step
    // that needs it (confirming his own medicine import). He creates it on "Your PIN" with
    // his account password, as a real owner would.
    const pinPrompt = page
      .locator('[data-slot="section-card"]')
      .filter({ has: page.getByRole('heading', { name: 'Create your PIN', exact: true }) });
    await click(pinPrompt.getByRole('link', { name: 'Create your PIN', exact: true }));
    await expect(page).toHaveURL(new URL('/pharmacy/settings/pin', tenantOrigin).href);
    await noRawIdEntry(page);
    await page.getByLabel('Your current password', { exact: true }).fill(rotatedOwnerPassword);
    await page.getByLabel('PIN', { exact: true }).fill(ownerPin);
    await page.getByLabel('Type the PIN again', { exact: true }).fill(ownerPin);
    await click(page.getByRole('button', { name: 'Save PIN', exact: true }));
    await expect(page.getByText('Your PIN is set.', { exact: false })).toBeVisible();
    await setup(page);
    await expect(page.getByRole('heading', { name: 'Create your PIN', exact: true })).toHaveCount(
      0
    );

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
    const upload = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/upload' && response.request().method() === 'POST'
    );
    await page.locator('#licenceEvidence').setInputFiles(licenceEvidencePath);
    expect((await upload).status(), 'Licence evidence upload must succeed').toBe(200);
    await expect(page.getByText('Licence evidence attached', { exact: false })).toBeVisible();
    const evidenceUrl = await page.locator('input[name="licenceEvidenceFileRef"]').inputValue();
    const storedEvidence = await page.request.get(new URL(evidenceUrl, page.url()).href);
    expect(storedEvidence.status()).toBe(200);
    expect(await storedEvidence.body()).toEqual(readFileSync(licenceEvidencePath));
    for (const schedule of permittedScheduleLabels)
      await page.getByRole('checkbox', { name: schedule, exact: true }).check();
    await click(page.getByRole('button', { name: 'Save this version', exact: true }));
    await expect(page.getByText('Version 1 saved.', { exact: false })).toBeVisible();
    await setup(page);
    await expect(
      row(page, 'Premises and licences').getByText('Done', { exact: true })
    ).toBeVisible();

    await follow(page, 'Medicine catalog readiness', 'Set up medicines and packs');
    await click(page.locator('summary').filter({ hasText: 'Medicine reference connectors' }));
    await expect(page.getByLabel('CSV or Excel workbook')).toBeVisible();
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
    const proposal = page
      .locator('[data-slot="section-card"]')
      .filter({ has: page.getByRole('heading', { name: 'Connector proposals', exact: true }) })
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: medicineName, exact: true }) });
    await expect(proposal).toBeVisible();
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => {
          localStorage.setItem('theme', value);
          window.dispatchEvent(new Event('storage'));
        }, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const reducedMotion of ['no-preference', 'reduce'] as const) {
          await page.emulateMedia({ reducedMotion });
          await proposal.scrollIntoViewIfNeeded();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
          ).toBe(true);
          expect(
            await proposal.evaluate((element) => element.scrollWidth <= element.clientWidth)
          ).toBe(true);
          await page.screenshot({
            path: testInfo.outputPath(`reference-proposal-${width}-${theme}-${reducedMotion}.png`),
            fullPage: true,
          });
        }
      }
    }
    // The solo owner approves his own import with the PIN he created above.
    await page
      .getByLabel('Solo owner PIN for reference self-approval', { exact: true })
      .fill(ownerPin);
    const confirmation = proposal.getByRole('button', {
      name: 'Confirm reference proposal',
      exact: true,
    });
    await confirmation.focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .include('[aria-label="Connector proposals"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations
    ).toEqual([]);
    await click(confirmation);
    await expect(proposal).toHaveCount(0);
    const candidate = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: medicineName, exact: true }) });
    // Confirmation records the ACCEPT review; it must not be applied twice.
    await expect(candidate.getByRole('button', { name: 'accept', exact: true })).toBeDisabled();
    await expect(
      candidate.getByRole('button', { name: 'Publish assertions', exact: true })
    ).toBeEnabled();
    await click(candidate.getByRole('button', { name: 'Publish assertions', exact: true }));
    await expect(candidate).toHaveCount(0);
    await page.getByLabel('Medicine name', { exact: true }).fill(medicineName);
    await click(page.getByRole('button', { name: 'Find medicine', exact: true }));
    await choose(page.getByRole('combobox', { name: 'Medicine', exact: true }), medicineName);
    await choose(page.getByRole('combobox', { name: 'Presentation', exact: true }), '10 tablets');
    // Publication creates the default pack from the reviewed pack size and puts
    // the reviewed barcode on it, so opening stock can be imported by barcode.
    await expect(page.getByText('1 BOX = 10 units', { exact: true })).toBeVisible();
    await expect(page.getByText(`Barcode: ${barcode}`, { exact: true })).toBeVisible();
    await setup(page);
    await expect(
      row(page, 'Medicine catalog readiness').getByText('Done', { exact: true })
    ).toBeVisible();

    await follow(page, 'Parties and balances', 'Set up suppliers');
    const supplier = formFor(page, 'Add supplier');
    await fill(supplier, { name: data.supplier.name, legalName: data.supplier.legalName });
    await click(supplier.getByRole('button', { name: 'Add supplier', exact: true }));
    await click(page.getByRole('link').filter({ hasText: data.supplier.name }));
    await expect(
      page.getByRole('heading', { name: data.supplier.name, exact: true })
    ).toBeVisible();
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

    await receiving(page);
    // DEV-931: with his own PIN the solo owner is now a direct-purchase approver himself, so
    // receiving no longer stops at "No authorized approver is available". His own purchase
    // orders still need a second person, so he invites the colleague from Team.
    await expect(
      page.getByText('No authorized approver is available', { exact: true })
    ).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Approved by', exact: true })).toBeVisible();
    await page.goto(new URL('/team', tenantOrigin).href);
    await click(page.getByRole('button', { name: 'Add Member', exact: true }));
    await page.getByPlaceholder('Ali Raza', { exact: true }).fill('Test second approver');
    await page.getByPlaceholder('ali@pharmacy.pk', { exact: true }).fill(colleagueEmail);
    await page.getByPlaceholder('Pharmacist', { exact: true }).fill('Purchasing reviewer');
    await choose(page.getByLabel('Department', { exact: true }), 'Counter');
    // DEV-827: a pharmacy invite grants exactly the chosen role; the Administrator role is
    // the one whose access level is Admin.
    await choose(page.getByLabel('Role', { exact: true }), 'Administrator');
    await expect(page.getByText('Access level: Admin.', { exact: false })).toBeVisible();
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
    // A system administrator still needs an explicit procurement grant.
    await platform.goto(organizationUrl);
    const colleagueGrant = formFor(platform, 'Set override');
    await choose(colleagueGrant.locator('[name="userId"]'), colleagueEmail);
    await fill(colleagueGrant, {
      capability: 'pharmacy:procurement',
      reason: data.authorizationRef,
      expiresAt: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
    });
    await choose(colleagueGrant.locator('[name="effect"]'), 'ALLOW');
    const colleagueUpdated = platform.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/platform/control' &&
        response.request().method() === 'POST'
    );
    await click(colleagueGrant.getByRole('button', { name: 'Set override', exact: true }));
    expect((await colleagueUpdated).status()).toBe(200);
    // Shared hosts require workspace-aware sign-in after accepting the account.
    if (new URL(colleague.url()).pathname === '/login') {
      await fill(colleague, { email: colleagueEmail, password: colleaguePassword });
      await click(colleague.getByRole('button', { name: 'Sign in', exact: true }));
      await expect(colleague).not.toHaveURL(/\/login/);
    }
    await setup(colleague);
    await click(page.getByRole('button', { name: 'Done', exact: true }));
    await setup(page);

    await receiving(page);
    await click(
      page
        .getByRole('navigation', { name: 'Purchasing surfaces' })
        .getByRole('link', { name: /^Requisitions & orders/ })
    );
    const order = formFor(page, 'Draft order');
    // A line's packs and price appear once its medicine is chosen (progressive lines).
    await choose(order.locator('[name="orderMedicineId-0"]'), medicineName);
    await fill(order, { reference: orderReference, 'orderedPacks-0': '2', 'listPrice-0': '20.00' });
    await choose(order.locator('[name="supplierId"]'), data.supplier.name);
    await choose(order.locator('[name="branchId"]'), branchName);
    await click(order.getByRole('button', { name: 'Draft order', exact: true }));
    await click(page.getByRole('link', { name: 'View saved record', exact: true }));
    await click(page.getByRole('button', { name: 'Submit for approval', exact: true }));
    await expect(
      page.getByText('You raised this order, so you cannot approve it.', { exact: false })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await receiving(colleague);
    await click(
      colleague
        .getByRole('navigation', { name: 'Purchasing surfaces' })
        .getByRole('link', { name: /^Requisitions & orders/ })
    );
    await click(colleague.getByRole('link').filter({ hasText: orderReference }));
    await colleague.getByLabel('Decision note', { exact: true }).fill(data.receipt.approvalNote);
    await click(colleague.getByRole('button', { name: 'Approve', exact: true }));
    await click(colleague.getByRole('button', { name: 'Send to supplier', exact: true }));
    await expect(
      colleague.getByRole('link', { name: 'Receive against this order', exact: true })
    ).toBeVisible();

    await setup(page);
    await receiving(page);
    await choose(
      page.getByRole('combobox', { name: 'Purchase order', exact: true }),
      orderReference
    );
    await click(page.getByRole('button', { name: 'Open order', exact: true }));
    const receipt = formFor(page, 'File receipt (draft)');
    await fill(receipt, {
      reference: `GR-${suffix}`,
      supplierInvoiceRef: data.receipt.supplierInvoiceRef,
      warrantyEvidenceRef: data.receipt.warrantyEvidenceRef,
    });
    // A line can be received as up to three lots; this journey receives one, the first.
    await receipt.getByLabel('Batch number', { exact: true }).first().fill(`B-${suffix}`);
    await receipt.getByLabel('Printed expiry', { exact: true }).first().fill(expiry);
    await receipt.getByLabel('Printed MRP (PKR)', { exact: true }).first().fill('25.00');
    await receipt.getByLabel('Packs received', { exact: true }).first().fill('2');
    await choose(
      receipt.getByRole('combobox', { name: 'Receive into', exact: true }).first(),
      'Opening stock store'
    );
    await click(receipt.getByRole('button', { name: 'File receipt (draft)', exact: true }));
    await click(page.getByRole('link', { name: 'View saved record', exact: true }));
    await click(page.getByRole('button', { name: 'Post into stock', exact: true }));
    await setup(page);
    await expect(
      row(page, 'Opening stock readiness').getByText('Done', { exact: true })
    ).toBeVisible();

    // Staging supplies authorized evidence; the isolated CI lane labels its synthetic references.
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
    await lifecycle.locator('[name="reason"]').fill(data.authorizationRef);
    await click(lifecycle.getByRole('button', { name: 'Apply lifecycle change', exact: true }));
    await expect(
      platform.locator('[data-slot="page-header"]').getByText('ACTIVE', { exact: true })
    ).toBeVisible();

    await follow(page, 'Readiness and parallel run', 'Open pharmacy counter');
    // DEV-725: the shift starts by counting the drawer's opening cash.
    await page.getByLabel('Opening cash', { exact: true }).fill('0');
    await click(page.getByRole('button', { name: 'Open drawer', exact: true }));
    await expect(page.getByLabel('Scan or search', { exact: true })).toBeVisible();
    // Scan the reviewed barcode: Enter on a barcode with a single match adds one pack
    // (scan-to-add), exactly as a cashier's scanner would.
    await page.getByLabel('Scan or search', { exact: true }).fill(barcode);
    await page.getByLabel('Scan or search', { exact: true }).press('Enter');
    // The cart is a table, as the counter spec reads it.
    await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText(medicineName);
    await page.keyboard.press('F9');
    const amount = page.getByLabel('Amount', { exact: true });
    await expect(amount).toBeEnabled();
    const due = await amount.getAttribute('placeholder');
    expect(due).toMatch(/^\d+\.\d{2}$/);
    expect(Number(due)).toBeGreaterThan(0);
    // DEV-499: Cash received is prefilled with the balance due; Enter takes it.
    await expect(page.getByLabel('Cash received', { exact: true })).toHaveValue(due!);
    await page.keyboard.press('Enter');
    // DEV-637: a pharmacy receipt names the counter that issued it, as the counter spec checks.
    await expect(
      page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ })
    ).toBeVisible();
    await noRawIdEntry(page);
    expect(fourXx).toEqual([]);
  } finally {
    await colleagueContext.close();
    await platformContext.close();
  }
}
