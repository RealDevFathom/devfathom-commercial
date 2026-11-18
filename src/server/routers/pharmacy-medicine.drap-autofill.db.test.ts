/**
 * DEV-683 against migrated PostgreSQL with forced row-level security, as the restricted runtime
 * role. The real proposal guard trigger, RLS policies and transaction locks apply. Proves that a
 * draft saved from a DRAP row and the later confirmation of that row leave exactly one medicine,
 * that a different product sharing the registration number is never merged into it, and that a
 * case variant of the registration number cannot bypass the stated controlled flag.
 *
 * Synthetic DRAP-shaped data only. Skipped (never silently passed) without a database URL.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
// Role grants are covered by the router unit suite; here the data boundary is under test.
vi.mock('@/lib/abac', () => ({
  can: vi.fn(async () => true),
  subjectFromSession: (user: { id: string; role?: string; status?: string }) => ({
    id: user.id,
    role: user.role ?? 'EMPLOYEE',
    status: user.status ?? null,
  }),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

const suffix = randomBytes(5).toString('hex');
const ORG_A = `dev683_a_${suffix}`;
const ORG_B = `dev683_b_${suffix}`;
const EDITOR = `${ORG_A}_editor`;
const UPLOADER = `${ORG_A}_uploader`;
const REVIEWER = `${ORG_A}_reviewer`;

let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let medicineRouter: (typeof import('./pharmacy-medicine'))['pharmacyMedicineRouter'];
let connectors: typeof import('@/lib/pharmacy/reference-connectors');
let pg: typeof import('pg');
let owner: import('pg').Client;

function caller(db: ScopedDb, organizationId: string, userId: string) {
  return medicineRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-core'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: { id: userId, role: 'ADMIN', status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

const as = <T>(userId: string, run: (api: ReturnType<typeof caller>) => Promise<T>) =>
  withTenantDb(ORG_A, (db) => run(caller(db, ORG_A, userId)));

/** Uploads synthetic DRAP rows through the real connector path, as the uploader. */
async function upload(fileName: string, rows: Array<Record<string, string>>) {
  const headers = Object.keys(rows[0]!);
  const connector = new connectors.DrapRegistryFileConnector();
  const batchId = `batch-${fileName}-${suffix}`;
  const normalized = await connector.fetch({
    batchId,
    fileName,
    rows,
    mapping: connectors.drapRegistryMapping(headers),
  });
  for (let call = 0; call < 5; call += 1) {
    const run = await as(UPLOADER, (api) =>
      api.runReferenceConnectorNow({
        connectorId: 'drap-registry',
        batchId,
        fileName,
        rows: normalized.rows,
      })
    );
    if (run.status === 'COMPLETED') return;
  }
  throw new Error('DRAP upload did not complete');
}

async function referenceId(query: string) {
  const result = await as(EDITOR, (api) => api.drapReferenceSearch({ query }));
  const match = result.matches.find((row) => row.values.drapRegistrationNumber === query);
  if (!match) throw new Error(`No DRAP row for ${query}`);
  return match.referenceId;
}

const medicinesWith = (registration: string) =>
  withTenantDb(ORG_A, (db) =>
    db.medicine.findMany({
      where: { drapRegistrationNumber: { equals: registration, mode: 'insensitive' } },
    })
  );

const row = (values: Record<string, string>) => ({
  'Registration No': values.reg!,
  'Product Name': values.name!,
  Strength: values.strength ?? '500 mg',
  'Dosage Form': values.form ?? 'Tablet',
  'Pack Size': '10 tablets',
  'Prescription Status': values.rx ?? 'Prescription only',
  'Controlled Status': values.controlled ?? 'Controlled',
});

describeIfDatabase('DEV-683 DRAP auto-fill against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ pharmacyMedicineRouter: medicineRouter } = await import('./pharmacy-medicine'));
    connectors = await import('@/lib/pharmacy/reference-connectors');
    pg = await import('pg');
    owner = new pg.default.Client({ connectionString: TEST_DATABASE_URL });
    await owner.connect();
    const roles = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    // With either attribute the tenant and trigger cases would pass for the wrong reason.
    expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await owner.query(`SET app.is_platform_admin = 'true'`);
    for (const id of [ORG_A, ORG_B])
      await owner.query(
        `INSERT INTO organizations
           (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, $1, $1, 'PHARMACY', 'ONBOARDING', 'SHARED', now(), now())`,
        [id]
      );
  }, 120_000);

  afterAll(async () => {
    // Append-only fixture rows stay in the throwaway database; no trigger is weakened.
    await owner?.end();
  });

  it('saves a draft from a DRAP row and confirming that row leaves exactly one medicine', async () => {
    await upload('drap-one.csv', [row({ reg: 'SYN-C1', name: 'Synthamol' })]);
    const id = await referenceId('SYN-C1');
    const draft = await as(EDITOR, (api) =>
      api.addMedicineDraft({
        productName: 'Synthamol',
        strength: '500 mg',
        dosageForm: 'Tablet',
        pack: '10 tablets',
        drapRegistrationNumber: 'SYN-C1',
        rx: true,
        controlled: true,
        drapReferenceId: id,
      })
    );
    expect(draft.saleable).toBe(false);

    await as(REVIEWER, (api) =>
      api.decideReferenceConnectorProposal({ proposalId: id, decision: 'CONFIRM' })
    );
    const medicines = await medicinesWith('SYN-C1');
    expect(medicines).toHaveLength(1);
    expect(medicines[0]).toMatchObject({ id: draft.id, controlled: true, saleable: false });
    const proposal = await withTenantDb(ORG_A, (db) =>
      db.pharmacyReferenceConnectorProposal.findFirstOrThrow({ where: { id } })
    );
    expect(proposal).toMatchObject({ status: 'CONFIRMED', targetMedicineId: draft.id });
    // The medicine's own name and registration are kept, so the row's spelling is not accepted.
    const accepted = await withTenantDb(ORG_A, (db) =>
      db.medicineProvenance.findMany({ where: { medicineId: draft.id, status: 'ACCEPTED' } })
    );
    expect(accepted.map((item) => item.field)).not.toContain('productName');
    expect(accepted.map((item) => item.field)).not.toContain('drapRegistrationNumber');
    // Another organisation sees neither the reference rows nor the draft.
    await withTenantDb(ORG_B, async (db) => {
      expect(await db.pharmacyReferenceConnectorProposal.count()).toBe(0);
      expect(await db.medicine.count()).toBe(0);
    });
  });

  it('refuses to merge a different product that shares the registration number', async () => {
    await upload('drap-two.csv', [
      row({ reg: 'SYN-S1', name: 'Synthamol', rx: 'OTC', controlled: 'Not controlled' }),
    ]);
    const draft = await as(EDITOR, async (api) =>
      api.addMedicineDraft({
        productName: 'Synthamol',
        strength: '500 mg',
        dosageForm: 'Tablet',
        pack: '10 tablets',
        drapRegistrationNumber: 'SYN-S1',
        rx: false,
        controlled: false,
        drapReferenceId: await referenceId('SYN-S1'),
      })
    );
    // A later export lists a different product under the same number.
    await upload('drap-three.csv', [
      row({ reg: 'SYN-S1', name: 'Othermed', strength: '250 mg', form: 'Syrup' }),
    ]);
    const sibling = await withTenantDb(ORG_A, (db) =>
      db.pharmacyReferenceConnectorProposal.findFirstOrThrow({
        where: {
          status: 'PENDING',
          payload: { path: ['values', 'productName'], equals: 'Othermed' },
        },
      })
    );
    await expect(
      as(REVIEWER, (api) =>
        api.decideReferenceConnectorProposal({ proposalId: sibling.id, decision: 'CONFIRM' })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const [medicine] = await medicinesWith('SYN-S1');
    expect(medicine).toMatchObject({ id: draft.id, productName: 'Synthamol', controlled: false });
    expect(await medicinesWith('SYN-S1')).toHaveLength(1);
  });

  it('shows the reviewer the catalogue medicine and lets a stated flag raise, never lower', async () => {
    // A manual draft, entered before any DRAP data for this number existed.
    const draft = await as(EDITOR, (api) =>
      api.addMedicineDraft({
        productName: 'Synthaflex',
        strength: '500 mg',
        dosageForm: 'Tablet',
        pack: '10 tablets',
        drapRegistrationNumber: 'SYN-R1',
        rx: true,
        controlled: false,
      })
    );
    // The official row names the same product (case and spacing aside) and states controlled.
    await upload('drap-five.csv', [
      row({ reg: 'syn-r1 ', name: 'SYNTHAFLEX', strength: '500mg', rx: 'OTC' }),
    ]);
    const pending = await as(REVIEWER, (api) => api.referenceConnectorProposals());
    const proposal = pending.find((item) => item.catalogueMatch?.id === draft.id);
    expect(proposal?.catalogueMatch).toMatchObject({
      productName: 'Synthaflex',
      strength: '500 mg',
      dosageForm: 'Tablet',
      rx: true,
      controlled: false,
    });
    await as(REVIEWER, (api) =>
      api.decideReferenceConnectorProposal({ proposalId: proposal!.id, decision: 'CONFIRM' })
    );
    const medicines = await medicinesWith('SYN-R1');
    expect(medicines).toHaveLength(1);
    // Raised to controlled; the stated OTC does not lower prescription-only; name kept.
    expect(medicines[0]).toMatchObject({
      id: draft.id,
      productName: 'Synthaflex',
      controlled: true,
      rx: true,
    });
    const accepted = await withTenantDb(ORG_A, (db) =>
      db.medicineProvenance.findMany({
        where: { medicineId: draft.id, status: 'ACCEPTED', field: { in: ['rx', 'controlled'] } },
      })
    );
    expect(accepted.map((item) => item.field)).toEqual(['controlled']);
  });

  const manualDraft = (values: { name: string; strength: string; reg: string }) =>
    as(EDITOR, (api) =>
      api.addMedicineDraft({
        productName: values.name,
        strength: values.strength,
        dosageForm: 'Tablet',
        pack: '10 tablets',
        drapRegistrationNumber: values.reg,
        rx: false,
        controlled: false,
      })
    );

  // A row matched at upload stores only the fields that differ, so find it by its row key.
  const pendingFor = (registration: string) =>
    withTenantDb(ORG_A, (db) =>
      db.pharmacyReferenceConnectorProposal.findFirstOrThrow({
        where: { status: 'PENDING', rowSourceKey: `drap-${registration}` },
        orderBy: { createdAt: 'desc' },
      })
    );

  it('keeps decimal points: 2.5 mg is not 25 mg, and "250" is not "25.0"', async () => {
    const decimal = await manualDraft({ name: 'Synthadec', strength: '2.5 mg', reg: 'SYN-D1' });
    const named = await manualDraft({ name: 'Synthoxil 250', strength: '5 mg', reg: 'SYN-N1' });
    await upload('drap-decimal.csv', [
      row({ reg: 'SYN-D1', name: 'Synthadec', strength: '25 mg', rx: 'OTC', controlled: 'No' }),
      row({ reg: 'SYN-N1', name: 'Synthoxil 25.0', strength: '5 mg', rx: 'OTC', controlled: 'No' }),
    ]);
    for (const [registration, medicine] of [
      ['SYN-D1', decimal],
      ['SYN-N1', named],
    ] as const) {
      const proposal = await pendingFor(registration);
      await expect(
        as(REVIEWER, (api) =>
          api.decideReferenceConnectorProposal({ proposalId: proposal.id, decision: 'CONFIRM' })
        )
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const accepted = await withTenantDb(ORG_A, (db) =>
        db.medicineProvenance.count({ where: { medicineId: medicine.id, status: 'ACCEPTED' } })
      );
      expect(accepted).toBe(0);
    }
  });

  it('refuses a row matched at upload while a case-variant twin carries the number', async () => {
    const twinsCreated = await withTenantDb(ORG_A, (db) =>
      Promise.all(
        ['P3-TWO', 'p3-two '].map((reg) =>
          db.medicine.create({
            data: {
              productName: 'Synthatwin',
              drapRegistrationNumber: reg,
              productFamily: 'PHARMACEUTICAL',
              saleable: false,
            },
          })
        )
      )
    );
    const first = twinsCreated[0]!;
    await upload('drap-twin.csv', [row({ reg: 'P3-TWO', name: 'Synthatwin' })]);
    const proposal = await pendingFor('P3-TWO');
    // The upload matcher matched the exact spelling only.
    expect(proposal.targetMedicineId).toBe(first.id);
    await expect(
      as(REVIEWER, (api) =>
        api.decideReferenceConnectorProposal({ proposalId: proposal.id, decision: 'CONFIRM' })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Neither twin was changed.
    const twins = await withTenantDb(ORG_A, (db) =>
      db.medicine.findMany({ where: { id: { in: twinsCreated.map((medicine) => medicine.id) } } })
    );
    expect(twins.map((medicine) => [medicine.controlled, medicine.rx])).toEqual([
      [false, false],
      [false, false],
    ]);
  });

  it('does not let the draft’s editor confirm the DRAP row that validates it', async () => {
    await upload('drap-self.csv', [row({ reg: 'SYN-E1', name: 'Synthaself' })]);
    const proposalId = await referenceId('SYN-E1');
    await as(EDITOR, (api) =>
      api.addMedicineDraft({
        productName: 'Synthaself',
        strength: '500 mg',
        dosageForm: 'Tablet',
        pack: '10 tablets',
        drapRegistrationNumber: 'SYN-E1',
        rx: true,
        controlled: true,
        drapReferenceId: proposalId,
      })
    );
    await expect(
      as(EDITOR, (api) => api.decideReferenceConnectorProposal({ proposalId, decision: 'CONFIRM' }))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const proposal = await withTenantDb(ORG_A, (db) =>
      db.pharmacyReferenceConnectorProposal.findFirstOrThrow({ where: { id: proposalId } })
    );
    expect(proposal.status).toBe('PENDING');
  });

  it('applies the stated controlled flag to a case variant of the registration number', async () => {
    await upload('drap-four.csv', [row({ reg: 'SYN-K1', name: 'Synthakol' })]);
    await expect(
      as(EDITOR, (api) =>
        api.addMedicineDraft({
          productName: 'Synthakol',
          strength: '500 mg',
          dosageForm: 'Tablet',
          pack: '10 tablets',
          drapRegistrationNumber: ' syn-k1 ',
          rx: true,
          controlled: false,
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await medicinesWith('SYN-K1')).toHaveLength(0);
  });

  it('refuses a second draft whose registration differs only in case', async () => {
    await as(EDITOR, (api) =>
      api.addMedicineDraft({
        productName: 'Synthaplain',
        strength: '5 mg',
        dosageForm: 'Tablet',
        pack: '10 tablets',
        drapRegistrationNumber: 'SYN-P1',
        rx: false,
        controlled: false,
      })
    );
    await expect(
      as(EDITOR, (api) =>
        api.addMedicineDraft({
          productName: 'Synthaplain',
          strength: '5 mg',
          dosageForm: 'Tablet',
          pack: '10 tablets',
          drapRegistrationNumber: 'syn-p1',
          rx: false,
          controlled: false,
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await medicinesWith('SYN-P1')).toHaveLength(1);
  });
});
