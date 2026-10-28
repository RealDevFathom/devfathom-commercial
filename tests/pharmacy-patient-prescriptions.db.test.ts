import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const id = (label: string) => `rx_${label}_${suffix}`;

const owner = ownerUrl ? new pg.Client({ connectionString: ownerUrl }) : null;
const runtime = runtimeUrl ? new pg.Client({ connectionString: runtimeUrl }) : null;
const firstFill = runtimeUrl ? new pg.Client({ connectionString: runtimeUrl }) : null;
const secondFill = runtimeUrl ? new pg.Client({ connectionString: runtimeUrl }) : null;

const orgA = id('org_a');
const orgB = id('org_b');
const lineA = id('line_a');

async function tenant(client: pg.Client, organizationId: string) {
  await client.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
  await client.query(`SELECT set_config('app.current_organization_id', $1, false)`, [
    organizationId,
  ]);
}

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected PostgreSQL error ${code}`);
}

describeIfDatabase('RX-01/RX-02 PostgreSQL RLS and cumulative fills', () => {
  beforeAll(async () => {
    for (const url of [runtimeUrl!, ownerUrl!]) {
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname)) {
        throw new Error('Refusing to run pharmacy patient probes against a non-local database.');
      }
    }

    await Promise.all([
      owner!.connect(),
      runtime!.connect(),
      firstFill!.connect(),
      secondFill!.connect(),
    ]);
    await owner!.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);

    await owner!.query(
      `INSERT INTO organizations
        (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES
        ($1, $2, 'RX Tenant A', 'RX Tenant A', 'ACTIVE', 'SHARED', now(), now()),
        ($3, $4, 'RX Tenant B', 'RX Tenant B', 'ACTIVE', 'SHARED', now(), now())`,
      [orgA, `${orgA}-slug`, orgB, `${orgB}-slug`]
    );

    for (const [key, organizationId] of [
      ['a', orgA],
      ['b', orgB],
    ] as const) {
      await owner!.query(
        `INSERT INTO pharmacy_medicines
          (id, "organizationId", "productName", "productFamily", "updatedAt")
         VALUES ($1, $2, $3, 'PHARMACEUTICAL', now())`,
        [id(`medicine_${key}`), organizationId, `Medicine ${key}`]
      );
      await owner!.query(
        `INSERT INTO pharmacy_presentations
          (id, "organizationId", "medicineId", presentation, "updatedAt")
         VALUES ($1, $2, $3, 'tablet', now())`,
        [id(`presentation_${key}`), organizationId, id(`medicine_${key}`)]
      );
      await owner!.query(
        `INSERT INTO pharmacy_patients (id, "organizationId", "displayName", "updatedAt")
         VALUES ($1, $2, $3, now())`,
        [id(`patient_${key}`), organizationId, `Patient ${key}`]
      );
      await owner!.query(
        `INSERT INTO pharmacy_prescribers
          (id, "organizationId", name, "registrationNumber")
         VALUES ($1, $2, $3, $4)`,
        [id(`prescriber_${key}`), organizationId, `Prescriber ${key}`, `REG-${key}-${suffix}`]
      );
      await owner!.query(
        `INSERT INTO pharmacy_prescriptions
          (id, "organizationId", "patientId", "prescriberId", "sourceKind", "sourceFileRef",
           "validFrom", "validUntil", "authorizedRepeats", "capturedByUserId")
         VALUES ($1, $2, $3, $4, 'PAPER_IMAGE', $5, now(), now() + interval '30 days', 1, $6)`,
        [
          id(`prescription_${key}`),
          organizationId,
          id(`patient_${key}`),
          id(`prescriber_${key}`),
          `paper/${key}/${suffix}`,
          id(`capturer_${key}`),
        ]
      );
      await owner!.query(
        `INSERT INTO pharmacy_prescription_lines
          (id, "organizationId", "prescriptionId", "lineNumber", "medicineId", "presentationId",
           "authorizedCanonicalUnits", directions)
         VALUES ($1, $2, $3, 1, $4, $5, 100, 'Take daily')`,
        [
          id(`line_${key}`),
          organizationId,
          id(`prescription_${key}`),
          id(`medicine_${key}`),
          id(`presentation_${key}`),
        ]
      );
    }

    await Promise.all([
      tenant(runtime!, orgA),
      tenant(firstFill!, orgA),
      tenant(secondFill!, orgA),
    ]);
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), runtime?.end(), firstFill?.end(), secondFill?.end()]);
  });

  it('uses a LOGIN role without SUPERUSER or BYPASSRLS', async () => {
    const role = await runtime!.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls
         FROM pg_catalog.pg_roles
        WHERE rolname = current_user`
    );
    expect(role.rows[0]).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it('hides another tenant and rejects explicit cross-tenant writes', async () => {
    const visible = await runtime!.query(`SELECT id FROM pharmacy_patients ORDER BY id`);
    expect(visible.rows).toEqual([{ id: id('patient_a') }]);

    await expectPgCode('42501', () =>
      runtime!.query(
        `INSERT INTO pharmacy_patients (id, "organizationId", "displayName", "updatedAt")
         VALUES ($1, $2, 'Cross tenant', now())`,
        [id('cross_tenant_patient'), orgB]
      )
    );
  });

  it('serializes concurrent fills and commits only the authorized cumulative quantity', async () => {
    await firstFill!.query('BEGIN');
    await firstFill!.query(
      `INSERT INTO pharmacy_prescription_fills
        (id, "prescriptionLineId", "fillSequence", "quantityCanonicalUnits",
         "dispensedByUserId", "idempotencyKey")
       VALUES ($1, $2, 1, 60, $3, $4)`,
      [id('fill_first'), lineA, id('dispenser'), id('fill_key_first')]
    );

    await secondFill!.query('BEGIN');
    const secondPid = (await secondFill!.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid;
    const competingFill = secondFill!.query(
      `INSERT INTO pharmacy_prescription_fills
        (id, "prescriptionLineId", "fillSequence", "quantityCanonicalUnits",
         "dispensedByUserId", "idempotencyKey")
       VALUES ($1, $2, 1, 60, $3, $4)`,
      [id('fill_second'), lineA, id('dispenser'), id('fill_key_second')]
    );

    // Attach the rejection assertion before releasing the lock so a fast
    // PostgreSQL refusal cannot become an unhandled rejection.
    const refusedFill = expectPgCode('23514', () => competingFill);
    let observedLockWait = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const activity = await owner!.query<{ blocked: boolean }>(
        `SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked`,
        [secondPid]
      );
      if (activity.rows[0]?.blocked) {
        observedLockWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(observedLockWait).toBe(true);

    await firstFill!.query('COMMIT');
    await refusedFill;
    await secondFill!.query('ROLLBACK');

    const cumulative = await runtime!.query<{ fills: number; units: number }>(
      `SELECT count(*)::int AS fills, coalesce(sum("quantityCanonicalUnits"), 0)::int AS units
         FROM pharmacy_prescription_fills
        WHERE "prescriptionLineId" = $1`,
      [lineA]
    );
    expect(cumulative.rows[0]).toEqual({ fills: 1, units: 60 });
  });

  it('keeps consent, prescription, line and fill events append-only', async () => {
    await runtime!.query(
      `INSERT INTO pharmacy_patient_consents
        (id, "patientId", purpose, channel, version, granted, "recordedByUserId")
       VALUES ($1, $2, 'DISPENSING', 'IN_PERSON', 1, true, $3)`,
      [id('consent'), id('patient_a'), id('recorder')]
    );

    for (const [table, rowId] of [
      ['pharmacy_patient_consents', id('consent')],
      ['pharmacy_prescriptions', id('prescription_a')],
      ['pharmacy_prescription_lines', lineA],
      ['pharmacy_prescription_fills', id('fill_first')],
    ] as const) {
      await expectPgCode('23514', () =>
        runtime!.query(`DELETE FROM ${table} WHERE id = $1`, [rowId])
      );
    }
  });
});
