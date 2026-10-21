import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async () => ({
  // The integrated addLine labels its audit row through the real merge helper.
  annotateAudit: (await vi.importActual<typeof import('@/server/audit')>('@/server/audit'))
    .annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async () => false),
}));
vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(),
}));
vi.mock('@/lib/pharmacy/stock-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/stock-ledger')>()),
  onHand: vi.fn(),
}));
// The self-override cap's co-signer escape hatch runs verifyPharmacistPin, which
// hashes and locks a real credential row. Stub the credential primitives so a
// co-signed override can be exercised without a seeded PIN.
vi.mock('@/lib/restaurant/operator-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: vi.fn(async () => true),
  isLockedOut: vi.fn(() => false),
  registerFailedAttempt: vi.fn(() => ({})),
  clearLockout: vi.fn(() => ({})),
}));
vi.mock('@/lib/pharmacy/regulatory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/regulatory')>()),
  assertStoredBranchMayOperate: vi.fn(async () => undefined),
}));

import { can } from '@/lib/abac';
import {
  RX_SELF_OVERRIDE_MAX_COUNT_KEY,
  RX_SELF_OVERRIDE_MAX_VALUE_MINOR_KEY,
} from '@/lib/pharmacy/rx-override';
import { addSaleLine } from '@/lib/pharmacy/sales';
import { recordTrpcAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

const line = {
  branchId: 'branch-1',
  saleId: 'sale-1',
  medicineId: 'medicine-rx',
  presentationId: 'presentation-1',
  packLevelId: 'pack-1',
  saleUnit: 'STRIP' as const,
  quantity: 1,
  idempotencyKey: 'counter:sale-1:medicine-rx',
};

function fixture(flags: { rx?: boolean; restricted?: boolean } = { rx: true }) {
  const authorizationCreate = vi.fn(async ({ data }: { data: unknown }) => data);
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    $queryRaw: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    medicine: {
      findFirst: vi.fn(async () => ({
        id: 'medicine-rx',
        rx: false,
        restricted: false,
        controlled: false,
        ...flags,
      })),
    },
    presentation: {
      findFirst: vi.fn(async () => ({
        id: 'presentation-1',
        packLevels: [
          { id: 'pack-1', parentPackLevelId: null, unitsPerParent: 1 },
          { id: 'unit-1', parentPackLevelId: 'pack-1', unitsPerParent: 10 },
        ],
      })),
    },
    pharmacySale: {
      findFirst: vi.fn(
        async () =>
          ({ customerId: 'customer-1', customer: { patientId: 'patient-1' } }) as {
            customerId: string | null;
            customer: { patientId: string } | null;
          }
      ),
    },
    pharmacySaleLine: {
      findFirst: vi.fn(async () => null as unknown),
      // Prior self-override sale lines read for the rolling value cap.
      findMany: vi.fn(async () => [] as unknown[]),
    },
    prescriptionFill: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    prescriptionLine: { findFirst: vi.fn(async () => null as unknown) },
    restaurantOperatorCredential: { findFirst: vi.fn(async () => null), update: vi.fn() },
    // Server-side self-override cap: configured limits (empty → defaults) and the
    // pharmacist's prior self-overrides in the rolling window (none by default).
    organizationLimit: { findMany: vi.fn(async () => [] as unknown[]) },
    pharmacyRxLineAuthorization: {
      findFirst: vi.fn(async () => null as unknown),
      findMany: vi.fn(async () => [] as unknown[]),
      create: authorizationCreate,
    },
    pharmacyPharmacistReviewItem: {
      upsert: vi.fn(async () => ({ id: 'review-1' })),
    },
    pharmacyPharmacistReviewDecision: {
      create: vi.fn(async ({ data }: { data: unknown }) => data),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, authorizationCreate, caller: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(can).mockResolvedValue(false);
  vi.mocked(addSaleLine).mockResolvedValue({
    line: { id: 'line-1', quantity: 1, unitPriceMinor: 0, discountMinor: 0 },
    allocation: {},
  } as never);
});

describe('pharmacySales.addLine prescription gate (SEC)', () => {
  it.each([{ rx: true }, { restricted: true }])(
    'refuses a direct addLine for %o with no prescription or override',
    async (flags) => {
      const f = fixture(flags);
      await expect(f.caller.addLine(line)).resolves.toMatchObject({
        blocked: expect.stringContaining('prescription'),
      });
      expect(addSaleLine).not.toHaveBeenCalled();
      expect(f.authorizationCreate).not.toHaveBeenCalled();
    }
  );

  it('still adds an OTC line without any authorization', async () => {
    const f = fixture({ rx: false });
    await f.caller.addLine(line);
    expect(addSaleLine).toHaveBeenCalledOnce();
    expect(f.authorizationCreate).not.toHaveBeenCalled();
    expect(addSaleLine).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ canonicalUnitsPerSaleUnit: 10 })
    );
  });

  it('rejects a client-supplied canonical conversion instead of trusting it', async () => {
    const f = fixture({ rx: false });
    await expect(
      f.caller.addLine({ ...line, canonicalUnitsPerSaleUnit: 1 } as typeof line)
    ).rejects.toThrow();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('refuses a prescription line for another medicine or an expired prescription', async () => {
    const f = fixture();
    await expect(
      f.caller.addLine({ ...line, rxAuthorization: { prescriptionLineId: 'rx-line-other' } })
    ).resolves.toHaveProperty('blocked');
    f.db.prescriptionLine.findFirst.mockResolvedValueOnce({
      id: 'rx-line-1',
      fills: [],
      authorizedCanonicalUnits: 30,
      prescription: {
        patientId: 'patient-1',
        authorizedRepeats: 0,
        validFrom: new Date('2020-01-01'),
        validUntil: new Date('2020-02-01'),
      },
    });
    await expect(
      f.caller.addLine({ ...line, rxAuthorization: { prescriptionLineId: 'rx-line-1' } })
    ).resolves.toHaveProperty('blocked');
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('records a PRESCRIPTION authorization for a valid linked prescription line', async () => {
    const f = fixture();
    f.db.prescriptionLine.findFirst.mockResolvedValueOnce({
      id: 'rx-line-1',
      fills: [],
      authorizedCanonicalUnits: 30,
      prescription: {
        patientId: 'patient-1',
        authorizedRepeats: 0,
        validFrom: new Date(Date.now() - 86_400_000),
        validUntil: new Date(Date.now() + 86_400_000),
      },
    });
    await f.caller.addLine({ ...line, rxAuthorization: { prescriptionLineId: 'rx-line-1' } });
    expect(f.db.prescriptionLine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'rx-line-1',
          organizationId: 'org-1',
          medicineId: 'medicine-rx',
          presentationId: 'presentation-1',
        }),
      })
    );
    expect(f.authorizationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        saleLineId: 'line-1',
        kind: 'PRESCRIPTION',
        prescriptionLineId: 'rx-line-1',
        recordedByUserId: 'cashier-1',
      }),
    });
  });

  it('enforces cumulative units including repeats, and records exactly one fill', async () => {
    const f = fixture();
    f.db.prescriptionLine.findFirst.mockResolvedValue({
      id: 'rx-line-1',
      authorizedCanonicalUnits: 10,
      fills: [{ id: 'fill-1' }],
      prescription: {
        patientId: 'patient-1',
        authorizedRepeats: 1,
        validFrom: new Date('2020-01-01'),
        validUntil: new Date('2099-01-01'),
      },
    });
    f.db.$queryRaw.mockImplementation(async (sql: unknown) =>
      sql && typeof sql === 'object' && 'sql' in sql && String(sql.sql).includes('SUM(CASE')
        ? [{ units: BigInt(10) }]
        : ([] as never)
    );
    await expect(
      f.caller.addLine({ ...line, rxAuthorization: { prescriptionLineId: 'rx-line-1' } })
    ).resolves.not.toHaveProperty('blocked');
    expect(f.db.prescriptionFill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        quantityCanonicalUnits: 10,
        fillSequence: 2,
        idempotencyKey: 'rx:line-1',
        organizationId: 'org-1',
      }),
    });
    f.db.$queryRaw.mockImplementation(async (sql: unknown) =>
      sql && typeof sql === 'object' && 'sql' in sql && String(sql.sql).includes('SUM(CASE')
        ? [{ units: BigInt(20) }]
        : ([] as never)
    );
    await expect(
      f.caller.addLine({
        ...line,
        idempotencyKey: 'second',
        rxAuthorization: { prescriptionLineId: 'rx-line-1' },
      })
    ).resolves.toHaveProperty('blocked');
    expect(addSaleLine).toHaveBeenCalledOnce();
  });

  it('refuses a prescription for a different sale customer patient', async () => {
    const f = fixture();
    f.db.pharmacySale.findFirst.mockResolvedValue({
      customerId: 'customer-1',
      customer: { patientId: 'other-patient' },
    });
    f.db.prescriptionLine.findFirst.mockResolvedValue({
      id: 'rx-line-1',
      authorizedCanonicalUnits: 30,
      fills: [],
      prescription: {
        patientId: 'patient-1',
        authorizedRepeats: 0,
        validFrom: new Date('2020-01-01'),
        validUntil: new Date('2099-01-01'),
      },
    });
    await expect(
      f.caller.addLine({ ...line, rxAuthorization: { prescriptionLineId: 'rx-line-1' } })
      // #237: a patient mismatch reads differently from a missing prescription.
    ).resolves.toMatchObject({ blocked: expect.stringContaining('not for the patient') });
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(f.db.prescriptionFill.create).not.toHaveBeenCalled();
  });

  it('refuses an arbitrary patient prescription on a sale with no linked customer (SEC #236)', async () => {
    const f = fixture();
    f.db.pharmacySale.findFirst.mockResolvedValue({ customerId: null, customer: null });
    f.db.prescriptionLine.findFirst.mockResolvedValue({
      id: 'rx-line-1',
      authorizedCanonicalUnits: 30,
      fills: [],
      prescription: {
        patientId: 'patient-1',
        authorizedRepeats: 0,
        validFrom: new Date('2020-01-01'),
        validUntil: new Date('2099-01-01'),
      },
    });
    await expect(
      f.caller.addLine({ ...line, rxAuthorization: { prescriptionLineId: 'rx-line-1' } })
    ).resolves.toMatchObject({
      blocked: expect.not.stringContaining('not for the patient'),
    });
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(f.db.prescriptionFill.create).not.toHaveBeenCalled();
  });

  it('refuses a cashier override without an independent pharmacist PIN', async () => {
    const f = fixture();
    await expect(
      f.caller.addLine({ ...line, rxAuthorization: { override: { reason: 'Patient known' } } })
    ).resolves.toHaveProperty('blocked');
    await expect(
      f.caller.addLine({
        ...line,
        rxAuthorization: {
          override: { reason: 'Patient known', staffProfileId: 'sp-1', pin: '1234' },
        },
      })
    ).resolves.toHaveProperty('blocked');
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('records an audited OVERRIDE when the actor holds pharmacy:dispense', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const f = fixture();
    await f.caller.addLine({
      ...line,
      rxAuthorization: { override: { reason: 'Repeat chronic therapy, script at home' } },
    });
    expect(vi.mocked(can).mock.calls[0]![1]).toBe('pharmacy:dispense');
    expect(f.authorizationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        saleLineId: 'line-1',
        kind: 'OVERRIDE',
        prescriptionLineId: null,
        pharmacistUserId: 'cashier-1',
        reason: 'Repeat chronic therapy, script at home',
      }),
    });
    const [args] = vi.mocked(recordTrpcAudit).mock.calls[0]!;
    expect(args.ctx.audit?.detail).toMatchObject({
      category: 'PHARMACY_SAFETY',
      action: 'rx_override',
      metadata: { reason: 'Repeat chronic therapy, script at home' },
    });
  });

  it('signs a prescription-linked Rx line when the actor is a pharmacist (#235)', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const f = fixture();
    f.db.pharmacyRxLineAuthorization.findFirst.mockResolvedValue({
      prescriptionLineId: 'rx-line-1',
    });
    await expect(
      f.caller.signRxLine({ branchId: 'branch-1', saleLineId: 'line-1' })
    ).resolves.toMatchObject({ signed: true });
    expect(f.db.pharmacyPharmacistReviewItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          prescriptionLineId: 'rx-line-1',
          saleLineId: 'line-1',
        }),
      })
    );
    expect(f.db.pharmacyPharmacistReviewDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'SIGN', actorUserId: 'cashier-1' }),
    });
  });

  it('refuses a counter sign-off from a cashier with no pharmacist PIN (#235)', async () => {
    const f = fixture();
    f.db.pharmacyRxLineAuthorization.findFirst.mockResolvedValue({
      prescriptionLineId: 'rx-line-1',
    });
    await expect(
      f.caller.signRxLine({ branchId: 'branch-1', saleLineId: 'line-1' })
    ).resolves.toHaveProperty('blocked');
    expect(f.db.pharmacyPharmacistReviewDecision.create).not.toHaveBeenCalled();
  });

  it('refuses to sign a line with no linked prescription (#235)', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const f = fixture();
    await expect(
      f.caller.signRxLine({ branchId: 'branch-1', saleLineId: 'line-1' })
    ).resolves.toHaveProperty('blocked');
    expect(f.db.pharmacyPharmacistReviewItem.upsert).not.toHaveBeenCalled();
  });

  it('rejects giving both a prescription line and an override', async () => {
    const f = fixture();
    await expect(
      f.caller.addLine({
        ...line,
        rxAuthorization: { prescriptionLineId: 'rx-line-1', override: { reason: 'both' } },
      })
    ).rejects.toThrow();
  });
});

describe('pharmacySales.addLine self-override cap (SEC PR #195)', () => {
  const selfOverride = {
    ...line,
    rxAuthorization: { override: { reason: 'Known chronic patient, script at home' } },
  };

  it('records a self-override and queries only this pharmacist own prior ones', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const f = fixture();
    await expect(f.caller.addLine(selfOverride)).resolves.not.toHaveProperty('blocked');
    // The rolling-window query is scoped to the acting pharmacist's self-overrides:
    // a co-signed row (pharmacistUserId !== recordedByUserId) is excluded by it.
    expect(f.db.$queryRaw).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.stringContaining('pg_advisory_xact_lock(hashtextextended('),
      ]),
      'org-1:cashier-1'
    );
    expect(f.db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      f.db.pharmacyRxLineAuthorization.findMany.mock.invocationCallOrder[0]
    );
    expect(f.db.pharmacyRxLineAuthorization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          kind: 'OVERRIDE',
          pharmacistUserId: 'cashier-1',
          recordedByUserId: 'cashier-1',
          createdAt: { gte: expect.any(Date) },
        }),
      })
    );
    expect(f.authorizationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'OVERRIDE', pharmacistUserId: 'cashier-1' }),
    });
  });

  it('blocks and writes nothing once the count cap is reached, demanding a co-signer', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const f = fixture();
    f.db.organizationLimit.findMany.mockResolvedValue([
      { key: RX_SELF_OVERRIDE_MAX_COUNT_KEY, value: 1 },
    ]);
    f.db.pharmacyRxLineAuthorization.findMany.mockResolvedValue([{ saleLineId: 'prior-1' }]);
    f.db.pharmacySaleLine.findMany.mockResolvedValue([
      { quantity: 1, unitPriceMinor: 1_000, discountMinor: 0 },
    ]);
    await expect(f.caller.addLine(selfOverride)).resolves.toMatchObject({
      blocked: expect.stringContaining('co-sign'),
    });
    expect(f.authorizationCreate).not.toHaveBeenCalled();
    expect(f.db.prescriptionFill.create).not.toHaveBeenCalled();
  });

  it('blocks when this override tips the rolling value past the cap', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const f = fixture();
    f.db.organizationLimit.findMany.mockResolvedValue([
      { key: RX_SELF_OVERRIDE_MAX_VALUE_MINOR_KEY, value: 100 },
    ]);
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1', quantity: 10, unitPriceMinor: 50, discountMinor: 0 },
      allocation: {},
    } as never);
    await expect(f.caller.addLine(selfOverride)).resolves.toMatchObject({
      blocked: expect.stringContaining('value limit'),
    });
    expect(f.authorizationCreate).not.toHaveBeenCalled();
  });

  it('lets an independent pharmacist PIN co-sign past an exhausted cap, bypassing it', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const f = fixture();
    // Self-overrides fully disabled for the acting pharmacist...
    f.db.organizationLimit.findMany.mockResolvedValue([
      { key: RX_SELF_OVERRIDE_MAX_COUNT_KEY, value: 0 },
    ]);
    // ...but a second, distinct active pharmacist presents a valid PIN.
    f.db.restaurantOperatorCredential.findFirst.mockResolvedValue({
      id: 'cred-2',
      credentialHash: 'hash',
      staffProfile: {
        status: 'ACTIVE',
        user: { id: 'pharmacist-2', status: 'ACTIVE', organizationId: 'org-1' },
      },
    });
    await expect(
      f.caller.addLine({
        ...line,
        rxAuthorization: {
          override: { reason: 'Second pharmacist co-signed', staffProfileId: 'sp-2', pin: '4321' },
        },
      })
    ).resolves.not.toHaveProperty('blocked');
    // A co-signed override is the escape hatch: the self-override cap is never consulted.
    expect(f.db.pharmacyRxLineAuthorization.findMany).not.toHaveBeenCalled();
    expect(f.authorizationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'OVERRIDE',
        pharmacistUserId: 'pharmacist-2',
        recordedByUserId: 'cashier-1',
      }),
    });
  });
});

// Real PostgreSQL row-lock coverage without a migrated application database.
// The isolated tables retain FORCE RLS and run under a non-bypass tenant role.
describe.skipIf(!process.env.RX_GATE_DATABASE_URL)('Rx quantity concurrency (PostgreSQL)', () => {
  it('serializes sequential and concurrent fills and releases voids and returns', async () => {
    const { Client } = await import('pg');
    const { Prisma } = await import('@/generated/prisma/client');
    const { randomUUID } = await import('node:crypto');
    const schema = `rx_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({ connectionString: process.env.RX_GATE_DATABASE_URL });
    await admin.connect();
    const clients: InstanceType<typeof Client>[] = [];
    try {
      await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
        CREATE ROLE ${schema} NOSUPERUSER NOBYPASSRLS;
        CREATE TABLE pharmacy_prescription_lines (id text, "organizationId" text);
        CREATE TABLE pharmacy_sales (id text, "organizationId" text, "branchId" text, status text);
        CREATE TABLE pharmacy_sale_lines (id text, "organizationId" text, "saleId" text);
        CREATE TABLE pharmacy_sale_return_lines ("organizationId" text, "saleLineId" text, "canonicalUnits" int);
        CREATE TABLE pharmacy_prescription_fills ("organizationId" text, "prescriptionLineId" text, "fillSequence" int, "quantityCanonicalUnits" int, "idempotencyKey" text, UNIQUE ("organizationId", "prescriptionLineId", "fillSequence"));
        INSERT INTO pharmacy_prescription_lines VALUES ('rx-line-1', 'org-1');
        INSERT INTO pharmacy_sales VALUES ('sale-1','org-1','branch-1','OPEN');
        GRANT USAGE ON SCHEMA ${schema} TO ${schema};
        GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ${schema};`);
      for (const table of [
        'pharmacy_prescription_lines',
        'pharmacy_sales',
        'pharmacy_sale_lines',
        'pharmacy_sale_return_lines',
        'pharmacy_prescription_fills',
      ]) {
        await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant ON ${table} USING ("organizationId" = current_setting('app.current_organization_id')) WITH CHECK ("organizationId" = current_setting('app.current_organization_id'));`);
      }
      async function caller() {
        const client = new Client({ connectionString: process.env.RX_GATE_DATABASE_URL });
        await client.connect();
        clients.push(client);
        // Apply each session setting independently. Sending SET ROLE in the
        // same extended query as search_path made the effective schema depend
        // on driver/server multi-statement handling in the real-DB job.
        await client.query(`SET ROLE ${schema}`);
        await client.query(`SET search_path TO ${schema}`);
        await client.query("SELECT set_config('app.current_organization_id','org-1',false)");
        const f = fixture();
        f.db.$transaction.mockImplementation(async (callback) => {
          await client.query('BEGIN');
          try {
            const result = await callback(f.db);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });
        f.db.$queryRaw.mockImplementation(async (...args: unknown[]) => {
          const sql = Array.isArray(args[0])
            ? Prisma.sql(args[0] as unknown as TemplateStringsArray, ...args.slice(1))
            : (args[0] as InstanceType<typeof Prisma.Sql>);
          return (await client.query(sql.text, sql.values)).rows;
        });
        f.db.prescriptionLine.findFirst.mockImplementation(async () => ({
          id: 'rx-line-1',
          authorizedCanonicalUnits: 10,
          prescription: {
            patientId: 'patient-1',
            authorizedRepeats: 1,
            validFrom: new Date('2020-01-01T00:00:00Z'),
            validUntil: new Date('2099-01-01T00:00:00Z'),
          },
          fills: (await client.query('SELECT * FROM pharmacy_prescription_fills')).rows,
        }));
        f.db.prescriptionFill.create.mockImplementation(async ({ data }) => {
          const d = data as Record<string, unknown>;
          await client.query('INSERT INTO pharmacy_prescription_fills VALUES ($1,$2,$3,$4,$5)', [
            d.organizationId,
            d.prescriptionLineId,
            d.fillSequence,
            d.quantityCanonicalUnits,
            d.idempotencyKey,
          ]);
          return data;
        });
        return f.caller;
      }
      vi.mocked(addSaleLine).mockImplementation(async (db) => {
        const id = randomUUID();
        await db.$queryRaw(
          Prisma.sql`INSERT INTO pharmacy_sale_lines VALUES (${id}, 'org-1', 'sale-1')`
        );
        return { line: { id }, allocation: {} } as never;
      });
      const a = await caller();
      const b = await caller();
      let key = 0;
      const add = (c: typeof a) =>
        c.addLine({
          ...line,
          idempotencyKey: `db:${key++}`,
          rxAuthorization: { prescriptionLineId: 'rx-line-1' },
        });
      await expect(add(a)).resolves.not.toHaveProperty('blocked');
      await expect(add(b)).resolves.not.toHaveProperty('blocked');
      await expect(add(a)).resolves.toHaveProperty('blocked');
      await admin.query('TRUNCATE pharmacy_prescription_fills, pharmacy_sale_lines');
      const outcomes = await Promise.all([add(a), add(b), add(await caller())]);
      expect(outcomes.filter((row) => 'blocked' in row)).toHaveLength(1);
      expect(
        (
          await admin.query(
            'SELECT SUM("quantityCanonicalUnits")::int AS units FROM pharmacy_prescription_fills'
          )
        ).rows[0].units
      ).toBe(20);
      await admin.query("UPDATE pharmacy_sales SET status = 'VOID'");
      await expect(add(a)).resolves.not.toHaveProperty('blocked');
      await admin.query("UPDATE pharmacy_sales SET status = 'OPEN'");
      await admin.query(
        'INSERT INTO pharmacy_sale_return_lines SELECT "organizationId", id, 10 FROM pharmacy_sale_lines'
      );
      await expect(add(a)).resolves.not.toHaveProperty('blocked');
      // Other tenants cannot read or inject fills under the runtime role.
      expect(
        (
          await clients[0]!.query(
            'SELECT * FROM pharmacy_prescription_fills WHERE "organizationId"=\'other\''
          )
        ).rows
      ).toEqual([]);
      await expect(
        clients[0]!.query(
          "INSERT INTO pharmacy_prescription_fills VALUES ('other','rx-line-1',99,100,'bad')"
        )
      ).rejects.toThrow('row-level security');
    } finally {
      await Promise.all(clients.map((client) => client.end()));
      try {
        // Setup can roll back before the schema exists (for example, a test
        // role without CREATEROLE). Preserve that failure instead of masking it.
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP ROLE IF EXISTS ${schema}`);
      } finally {
        await admin.end();
      }
    }
  }, 20_000);
});
