/**
 * @vitest-environment node
 *
 * CAM-3 camera presets and cold-chain excursion evidence against a REAL
 * migrated PostgreSQL. Readings that put a watched zone into EXCURSION request
 * one still per excursion run inside the ingest transaction; the CAM-2 relay
 * and pharmacy.camera.snapshot.v1 job capture it from the simulated gateway;
 * retention clears it unless an AUDIT legal hold names the excursion.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role. RLS is asserted here, so the suite first proves that
 * role is neither SUPERUSER nor BYPASSRLS. Without the URL it reports skipped.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.CAMERA_GATEWAY_MODE = 'simulated';

// See jobs.purge.db.test.ts: a connection string avoids the cross-realm pg.Pool
// instanceof failure the shared client hits under Vitest.
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 10 }),
    log: ['error'],
  }),
}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Scope = { organizationId: string; branchId: string; actorId: string };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let processPlatformJobs: typeof import('@/lib/platform/jobs').processPlatformJobs;
let storage: typeof import('@/lib/storage');
let temperature: typeof import('@/lib/pharmacy/temperature-log');
let counterEvidence: typeof import('@/lib/pharmacy/counter-evidence');
let excursion: typeof import('./excursion-evidence');
let presets: typeof import('./camera-preset');
let timeline: typeof import('@/components/camera/excursion-evidence-timeline');
let directory: string;

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const PNG_DATA_URL = /^data:image\/png;base64,iVBORw0KGgo/;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  directory = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'cam3-'));
  // Integrated tip: storage fails closed unless an adapter is named explicitly.
  vi.stubEnv('STORAGE_ADAPTER', 'local');
  // storage.ts resolves its local root on every call, so pin it to scratch
  // explicitly (mocking cwd only during import left stills in the repo).
  vi.stubEnv('LOCAL_UPLOADS_DIR', join(directory, 'private-uploads'));
  storage = await import('@/lib/storage');

  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  ({ processPlatformJobs } = await import('@/lib/platform/jobs'));
  temperature = await import('@/lib/pharmacy/temperature-log');
  counterEvidence = await import('@/lib/pharmacy/counter-evidence');
  excursion = await import('./excursion-evidence');
  presets = await import('./camera-preset');
  timeline = await import('@/components/camera/excursion-evidence-timeline');

  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const tenant = <T>(scope: Scope, work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(scope.organizationId, work, { userId: scope.actorId });
const platform = <T>(work: (db: ScopedDb) => Promise<T>) => withPlatformDb(work);

/** One organization, a branch with a 2–8 °C fridge zone, and (optionally) its camera. */
async function setupTenant(
  label: string,
  options: { camera?: boolean; intervalMinutes?: number; durationMinutes?: number } = {}
) {
  const organizationId = `cam3_${label}_${run}`;
  const scope: Scope = {
    organizationId,
    branchId: `cam3_branch_${label}_${run}`,
    actorId: `cam3-actor-${label}`,
  };
  await platform((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  const { fridge, store, gateway, credential } = await tenant(scope, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId,
        code: scope.branchId,
        name: `Cold chain ${label}`,
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    });
    const fridge = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        code: `fridge-${randomUUID()}`,
        name: 'Vaccine fridge',
        kind: 'FRIDGE',
        coldChain: true,
        minimumTemperatureC: 2,
        maximumTemperatureC: 8,
        expectedTemperatureReadingIntervalMinutes: options.intervalMinutes ?? 15,
        temperatureExcursionDurationMinutes: options.durationMinutes ?? 30,
      },
    });
    const store = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        code: `store-${randomUUID()}`,
        name: 'Store',
        kind: 'STORE',
      },
    });
    const gateway = await db.cameraGateway.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        name: 'Fridge gateway',
        gatewaySecretHash: createHash('sha256').update(randomUUID()).digest('hex'),
        baseUrl: 'https://gateway.example.test/',
        retentionDays: 7,
      },
    });
    const credential = await db.cameraCredential.create({
      data: { organizationId, sealedValue: 'sealed-fixture' },
    });
    return { fridge, store, gateway, credential };
  });

  const addCamera = (data: { name: string; sourceRef: string }) =>
    tenant(scope, (db) =>
      db.camera.create({
        data: {
          organizationId,
          branchId: scope.branchId,
          gatewayId: gateway.id,
          credentialId: credential.id,
          ...data,
        },
      })
    );
  let camera: Awaited<ReturnType<typeof addCamera>> | null = null;
  if (options.camera !== false) {
    camera = await addCamera({ name: 'Fridge camera', sourceRef: 'sim-fridge-1' });
    await tenant(scope, (db) =>
      presets.setCameraPreset(db, scope, {
        cameraId: camera!.id,
        preset: 'COLD_CHAIN',
        temperatureZoneId: fridge.id,
      })
    );
  }

  /** Readings `minutesAgo` before `now`, through the real ingest path. */
  async function ingest(readings: Array<[minutesAgo: number, temperatureC: number]>, now: Date) {
    const csv = [
      'recordedAt,temperatureC',
      ...readings.map(
        ([ago, value]) => `${new Date(now.getTime() - ago * MINUTE_MS).toISOString()},${value}`
      ),
    ].join('\n');
    return tenant(scope, (db) =>
      temperature.ingestTemperatureReadings(
        db,
        scope,
        fridge.id,
        new temperature.CsvTemperatureReadingSource(csv)
      )
    );
  }

  const excursionRows = () =>
    tenant(scope, (db) =>
      db.cameraEvidence.findMany({
        where: { subjectKind: 'PHARMACY_TEMPERATURE_EXCURSION' },
        orderBy: { requestedAt: 'asc' },
      })
    );

  const capture = (evidenceId: string, now = new Date()) =>
    platform((db) =>
      counterEvidence.runCounterEvidenceSnapshotJob(
        db,
        { organizationId, type: 'PHARMACY_CAMERA_SNAPSHOT_V1', attempts: 1, maxAttempts: 3 },
        { evidenceId },
        { now }
      )
    );

  const retention = (now: Date) =>
    platform((db) =>
      counterEvidence.runCameraEvidenceRetentionJob(
        db,
        { organizationId, type: 'CAMERA_EVIDENCE_RETENTION_V1' },
        { now }
      )
    );

  return {
    scope,
    fridge,
    store,
    gateway,
    camera,
    addCamera,
    ingest,
    excursionRows,
    capture,
    retention,
  };
}

/** Four readings 15 minutes apart, all above 8 °C, spanning 39 minutes: an excursion. */
const SUSTAINED: Array<[number, number]> = [
  [40, 9.1],
  [25, 9.4],
  [10, 9.8],
  [1, 10.2],
];

describeDatabase('CAM-3 camera presets on migrated PostgreSQL', () => {
  it('binds a cold-chain camera to a validated zone in its own branch only', async () => {
    const t = await setupTenant('preset', { camera: false });
    const other = await setupTenant('presetother', { camera: false });
    const camera = await t.addCamera({ name: 'Counter', sourceRef: 'sim-counter-1' });

    const bound = await tenant(t.scope, (db) =>
      presets.setCameraPreset(db, t.scope, {
        cameraId: camera.id,
        preset: 'COLD_CHAIN',
        temperatureZoneId: t.fridge.id,
      })
    );
    expect(bound).toEqual({ id: camera.id, preset: 'COLD_CHAIN', temperatureZoneId: t.fridge.id });

    for (const [zone, reason] of [
      [undefined, 'ZONE_REQUIRED'],
      [t.store.id, 'ZONE_NOT_COLD_CHAIN'],
      [other.fridge.id, 'ZONE_NOT_COLD_CHAIN'],
    ] as const) {
      await expect(
        tenant(t.scope, (db) =>
          presets.setCameraPreset(db, t.scope, {
            cameraId: camera.id,
            preset: 'COLD_CHAIN',
            temperatureZoneId: zone,
          })
        )
      ).rejects.toThrow(reason);
    }
    // Another tenant cannot even find the camera.
    await expect(
      tenant(other.scope, (db) =>
        presets.setCameraPreset(db, other.scope, { cameraId: camera.id, preset: 'COUNTER' })
      )
    ).rejects.toThrow('NOT_FOUND');

    // Any other preset clears the binding; null leaves the camera unclassified.
    expect(
      await tenant(t.scope, (db) =>
        presets.setCameraPreset(db, t.scope, {
          cameraId: camera.id,
          preset: 'COUNTER',
          temperatureZoneId: t.fridge.id,
        })
      )
    ).toMatchObject({ preset: 'COUNTER', temperatureZoneId: null });
    expect(
      await tenant(t.scope, (db) =>
        presets.setCameraPreset(db, t.scope, { cameraId: camera.id, preset: null })
      )
    ).toMatchObject({ preset: null, temperatureZoneId: null });
  });

  it('enforces the preset rules in the database, not only in the service', async () => {
    const t = await setupTenant('presetdb', { camera: false });
    const camera = await t.addCamera({ name: 'Raw', sourceRef: 'sim-camera-1' });
    for (const data of [
      { preset: 'COLD_CHAIN' as const, temperatureZoneId: null },
      { preset: 'COUNTER' as const, temperatureZoneId: t.fridge.id },
      { preset: null, temperatureZoneId: t.fridge.id },
    ]) {
      await expect(
        tenant(t.scope, (db) => db.camera.update({ where: { id: camera.id }, data }))
      ).rejects.toThrow(/cameras_temperature_zone_check/);
    }

    // restaurant_cameras: kitchen and counter only.
    const restaurantCamera = await tenant(t.scope, (db) =>
      db.restaurantCamera.create({
        data: {
          organizationId: t.scope.organizationId,
          branchId: t.scope.branchId,
          gatewayId: 'restaurant-gateway',
          credentialId: 'restaurant-credential',
          name: 'Pass',
          sourceRef: 'sim-kitchen-1',
          preset: 'KITCHEN',
        },
      })
    );
    expect(restaurantCamera.preset).toBe('KITCHEN');
    await expect(
      tenant(t.scope, (db) =>
        db.restaurantCamera.update({
          where: { id: restaurantCamera.id },
          data: { preset: 'COLD_CHAIN' },
        })
      )
    ).rejects.toThrow(/restaurant_cameras_preset_check/);
  });
});

describeDatabase('CAM-3 excursion evidence on migrated PostgreSQL', () => {
  it('requests one still per excursion, captures it, and shows it on the timeline', async () => {
    const t = await setupTenant('capture');
    const now = new Date();
    await t.ingest(SUSTAINED, now);

    const [requested] = await t.excursionRows();
    expect(requested).toMatchObject({
      status: 'PENDING',
      branchId: t.scope.branchId,
      cameraId: t.camera!.id,
      saleId: null,
      temperatureZoneId: t.fridge.id,
      readingTemperatureC: 10.2,
      readingRecordedAt: new Date(now.getTime() - MINUTE_MS),
    });
    // The run's first reading names the excursion.
    const runStart = await tenant(t.scope, (db) =>
      db.pharmacyTemperatureLog.findUniqueOrThrow({ where: { id: requested!.subjectId } })
    );
    expect(runStart.recordedAt).toEqual(new Date(now.getTime() - 40 * MINUTE_MS));

    // More readings in the same run, sequentially and concurrently, bind nothing new.
    await t.ingest([[0, 10.4]], now);
    await Promise.all([t.ingest([[0, 10.5]], now), t.ingest([[0, 10.6]], now)]);
    expect(await t.excursionRows()).toHaveLength(1);

    const pass = await processPlatformJobs(50);
    expect(pass.failed).toBe(0);
    const [captured] = await t.excursionRows();
    expect(captured).toMatchObject({
      id: requested!.id,
      status: 'CAPTURED',
      readingTemperatureC: 10.2,
    });
    expect(captured!.storageKey).toMatch(/^camera-snapshot-[a-f0-9-]+\.png$/);

    const entries = await tenant(t.scope, (db) =>
      excursion.readExcursionEvidence(db, t.scope, (key) =>
        counterEvidence.stillDataUrl(t.scope.organizationId, key)
      )
    );
    expect(entries).toEqual([
      expect.objectContaining({
        id: requested!.id,
        status: 'CAPTURED',
        readingTemperatureC: 10.2,
        temperatureZoneId: t.fridge.id,
        image: expect.stringMatching(PNG_DATA_URL),
      }),
    ]);
    expect(JSON.stringify(entries)).not.toContain(captured!.storageKey!);
    const html = renderToStaticMarkup(
      createElement(timeline.ExcursionEvidenceTimeline, {
        entries,
        zoneNames: new Map([[t.fridge.id, 'Vaccine fridge']]),
      })
    );
    expect(html).toContain('aria-label="Excursion evidence"');
    expect(html).toContain('Vaccine fridge · 10.2 °C');
    expect(html).toMatch(
      /<img alt="Camera still for the Vaccine fridge excursion at [^"]+" [^>]*src="data:image\/png;base64,/
    );
  });

  it('requests nothing without a watching camera, for a pending run, for a backlog, or on rollback', async () => {
    const now = new Date();
    const bare = await setupTenant('bare', { camera: false });
    await bare.ingest(SUSTAINED, now);
    expect(await bare.excursionRows()).toEqual([]);

    // A counter camera does not watch the fridge.
    const counter = await setupTenant('counteronly', { camera: false });
    const counterCamera = await counter.addCamera({ name: 'Till', sourceRef: 'sim-counter-1' });
    await tenant(counter.scope, (db) =>
      presets.setCameraPreset(db, counter.scope, { cameraId: counterCamera.id, preset: 'COUNTER' })
    );
    await counter.ingest(SUSTAINED, now);
    expect(await counter.excursionRows()).toEqual([]);

    // Out of range but not yet for the excursion duration.
    const pending = await setupTenant('pending');
    await pending.ingest(
      [
        [20, 9.1],
        [1, 9.4],
      ],
      now
    );
    expect(await pending.excursionRows()).toEqual([]);

    // A slow logger (60-minute interval) still in EXCURSION, but its newest
    // reading is 20 minutes old: a still taken now would not show it.
    const backlog = await setupTenant('backlog', { intervalMinutes: 60 });
    await backlog.ingest(
      [
        [80, 9.1],
        [60, 9.4],
        [40, 9.8],
        [20, 10.2],
      ],
      now
    );
    expect(await backlog.excursionRows()).toEqual([]);

    // The request lives in the ingest transaction: a rollback takes it with it.
    const rolled = await setupTenant('rollback');
    const failure = new Error('ingest aborted after the evidence request');
    await expect(
      tenant(rolled.scope, async (db) => {
        await temperature.ingestTemperatureReadings(
          db,
          rolled.scope,
          rolled.fridge.id,
          new temperature.CsvTemperatureReadingSource(
            [
              'recordedAt,temperatureC',
              ...SUSTAINED.map(
                ([ago, value]) =>
                  `${new Date(now.getTime() - ago * MINUTE_MS).toISOString()},${value}`
              ),
            ].join('\n')
          )
        );
        expect(
          await db.cameraEvidence.count({
            where: { subjectKind: 'PHARMACY_TEMPERATURE_EXCURSION' },
          })
        ).toBe(1);
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(await rolled.excursionRows()).toEqual([]);
  });

  it('keeps excursion evidence tenant- and branch-isolated and its reading immutable', async () => {
    const a = await setupTenant('rlsa');
    const b = await setupTenant('rlsb', { camera: false });
    await a.ingest(SUSTAINED, new Date());
    const [row] = await a.excursionRows();

    expect(await tenant(b.scope, (db) => db.cameraEvidence.count({ where: { id: row!.id } }))).toBe(
      0
    );
    const readStill = async () => 'unused';
    expect(
      await tenant(b.scope, (db) => excursion.readExcursionEvidence(db, b.scope, readStill))
    ).toEqual([]);
    const otherBranch = { ...a.scope, branchId: b.scope.branchId };
    expect(
      await tenant(a.scope, (db) => excursion.readExcursionEvidence(db, otherBranch, readStill))
    ).toEqual([]);
    // Another tenant cannot point its readings at this tenant's camera.
    await expect(
      tenant(b.scope, (db) =>
        excursion.requestExcursionEvidence(db, b.scope, a.fridge.id, new Date())
      )
    ).resolves.toBeNull();

    for (const data of [
      { readingTemperatureC: 4 },
      { readingRecordedAt: new Date(0) },
      { temperatureZoneId: a.store.id },
    ]) {
      await expect(
        tenant(a.scope, (db) => db.cameraEvidence.update({ where: { id: row!.id }, data }))
      ).rejects.toThrow(/binding is immutable/);
    }
    // An excursion row without its reading, or a counter row with one, is refused.
    await expect(
      tenant(a.scope, (db) =>
        db.cameraEvidence.create({
          data: {
            organizationId: a.scope.organizationId,
            branchId: a.scope.branchId,
            subjectKind: 'PHARMACY_TEMPERATURE_EXCURSION',
            subjectId: `bare-${run}`,
            cameraId: a.camera!.id,
          },
        })
      )
    ).rejects.toThrow(/camera_evidence_reading_binding_check/);
    await expect(
      tenant(a.scope, (db) =>
        db.cameraEvidence.create({
          data: {
            organizationId: a.scope.organizationId,
            branchId: a.scope.branchId,
            subjectKind: 'PHARMACY_DAILY_CLOSE',
            subjectId: `close-${run}`,
            cameraId: a.camera!.id,
            temperatureZoneId: a.fridge.id,
            readingTemperatureC: 9,
            readingRecordedAt: new Date(),
          },
        })
      )
    ).rejects.toThrow(/camera_evidence_reading_binding_check/);
  });

  it('purges excursion stills past retention unless an AUDIT hold names the excursion', async () => {
    // The hook judges freshness by the wall clock, so two runs must both fall
    // inside the capture window: a fast logger (3-minute interval, 1-minute
    // excursion) gives two excursions split by one in-range reading.
    const t = await setupTenant('retention', { intervalMinutes: 3, durationMinutes: 1 });
    const capturedAt = new Date();
    await t.ingest(
      [
        [4, 9],
        [3.5, 9.4],
        [2.5, 9.8],
      ],
      capturedAt
    );
    await t.ingest([[2.2, 5]], capturedAt);
    await t.ingest(
      [
        [2, 9.1],
        [1, 9.5],
        [0.1, 10.2],
      ],
      capturedAt
    );
    const [held, free] = await t.excursionRows();
    expect([held!.readingTemperatureC, free!.readingTemperatureC]).toEqual([9.8, 10.2]);
    expect(held!.subjectId).not.toBe(free!.subjectId);
    for (const row of [held!, free!]) {
      expect((await t.capture(row.id, row.requestedAt)).outcome).toBe('CAPTURED');
    }
    const heldKey = (await t.excursionRows())[0]!.storageKey!;

    const hold = (recordClass: 'AUDIT' | 'FISCAL', kind: 'PLACED' | 'RELEASED', offset = 0) =>
      tenant(t.scope, (db) =>
        db.pharmacyLegalHoldEvent.create({
          data: {
            id: randomUUID(),
            organizationId: t.scope.organizationId,
            holdKey: `${recordClass}-cold-chain-${run}`,
            recordClass,
            recordId: held!.subjectId,
            kind,
            reason: 'Cold-chain inspection',
            actorUserId: t.scope.actorId,
            createdAt: new Date(Date.now() + offset),
          },
        })
      );
    // A FISCAL hold is for money records; it does not keep an excursion still.
    await hold('FISCAL', 'PLACED');
    await hold('AUDIT', 'PLACED');

    const due = await t.retention(new Date(capturedAt.getTime() + 9 * DAY_MS));
    expect(due.purgedIds).toEqual([free!.id]);
    expect(due.held).toEqual([{ id: held!.id, holdKeys: [`AUDIT-cold-chain-${run}`] }]);
    const rows = await t.excursionRows();
    expect(rows.map((row) => row.status)).toEqual(['CAPTURED', 'PURGED']);
    // The record outlives the image: the reading stays.
    expect(rows[1]).toMatchObject({ storageKey: null, readingTemperatureC: 10.2 });
    expect(await storage.getUpload(t.scope.organizationId, heldKey)).toBeInstanceOf(Buffer);

    await hold('AUDIT', 'RELEASED', 1_000);
    const released = await t.retention(new Date(capturedAt.getTime() + 9 * DAY_MS));
    expect(released.purgedIds).toEqual([held!.id]);
    await expect(storage.getUpload(t.scope.organizationId, heldKey)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
