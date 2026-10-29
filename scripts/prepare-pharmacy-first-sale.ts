/** Synthetic jurisdiction/evidence for the disposable counter lane, never staging attestation. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { resolvePharmacyE2eDatabaseUrl } from './pharmacy-e2e-environment';

async function main() {
  const url = resolvePharmacyE2eDatabaseUrl();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Synthetic first-sale preparation requires loopback PostgreSQL.');
  }
  const output = process.env.PHARMACY_FIRST_SALE_INPUT;
  if (!output) throw new Error('Disposable first-sale input output path is required.');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.is_platform_admin','true',true)");
    await client.query(`INSERT INTO pharmacy_jurisdiction_rule_sets
      (id,code,version,"effectiveFrom","licenceCategories","permittedSchedules","prescriptionOnlyClasses","prescriptionRetentionDays","controlledRegisterFlags","pharmacistCoverageRule","recordRetentionByClass")
      VALUES ('e2e_first_sale_sd','PK-SD',1,'2026-01-01',
      '{"values":["RETAIL"],"provisional":false}', '{"values":["G"],"provisional":false}',
      '{"values":[],"provisional":false}', '{"values":{},"provisional":false}',
      '{"values":{},"provisional":false}', '{"values":{},"provisional":false}',
      '{"values":{},"provisional":false}') ON CONFLICT (code,version) DO NOTHING`);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
  mkdirSync(dirname(output), { recursive: true });
  const evidencePath = resolve(dirname(output), 'synthetic-licence.png');
  copyFileSync(
    resolve('tests/e2e/fixtures/restaurant-lifecycles-final/final-service-menu.png'),
    evidencePath
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const start = '2026-01-01';
  const end = '2030-12-31';
  const reference = 'disposable-e2e://synthetic-first-sale';
  const steps = [
    'Organization type',
    'Legal business',
    'Launch jurisdiction',
    'Branches and locations',
    'Devices and documents',
    'Readiness and parallel run',
  ];
  writeFileSync(
    output,
    JSON.stringify(
      {
        environment: 'DISPOSABLE_E2E',
        authorizationRef: reference,
        sourceSha: sha,
        deployedSha: sha,
        packageLabel: 'Pharmacy Counter E2E',
        emailDomain: 'e2e.invalid',
        colleaguePhone: '+923001234567',
        legalName: 'Synthetic First Sale Pharmacy',
        branchAddress: '1 Synthetic Test Street',
        branchCity: 'Karachi',
        provinceLabel: 'Sindh',
        regulatory: {
          effectiveFrom: start,
          premisesStorageDescription: 'Synthetic temperature controlled test premises',
          licenceCategoryLabel: 'RETAIL',
          licenceNumber: 'SYNTHETIC-E2E',
          licenceValidFrom: start,
          licenceValidTo: end,
          licenceEvidencePath: evidencePath,
          permittedScheduleLabels: ['G'],
          qualifiedPersonRegistration: 'SYNTHETIC-QP',
          qualifiedPersonValidFrom: start,
          qualifiedPersonValidTo: end,
          qualifiedPersonCoverageRosterRef: reference,
        },
        supplier: {
          name: 'Synthetic First Sale Supplier',
          legalName: 'Synthetic Supplier Ltd',
          licenceType: 'WHOLESALE',
          licenceNumber: 'SYNTHETIC-SUPPLIER',
          issuingAuthority: 'Disposable E2E Fixture',
          issuedAt: start,
          expiresAt: end,
          evidenceUri: reference,
          verifiedEvidenceRef: reference,
        },
        receipt: {
          supplierInvoiceRef: 'SYNTHETIC-INVOICE',
          warrantyEvidenceRef: reference,
          approvalNote: 'Synthetic disposable receipt approval',
        },
        attestations: Object.fromEntries(
          steps.map((step) => [step, `${reference}/${encodeURIComponent(step)}`])
        ),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  console.log('Prepared synthetic disposable pharmacy first-sale inputs.');
}
main().catch(() => {
  console.error('Could not prepare disposable pharmacy first-sale inputs.');
  process.exitCode = 1;
});
