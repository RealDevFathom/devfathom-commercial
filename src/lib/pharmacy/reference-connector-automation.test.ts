import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  manualConnectorInputDigest,
  MAX_CONNECTOR_ROWS_PER_CALL,
  runManualReferenceConnector,
} from './reference-connector-automation';
import { DRAP_REGISTRY_RIGHTS, type NormalizedMedicineReferenceRow } from './reference-connectors';

function row(
  rowSourceKey: string,
  values: NormalizedMedicineReferenceRow['values'],
  options: Partial<NormalizedMedicineReferenceRow> = {}
): NormalizedMedicineReferenceRow {
  return {
    batchId: 'batch-1',
    rowSourceKey,
    values,
    assertions: [],
    blockingIssues: [],
    ...options,
  };
}

type StoredRun = {
  id: string;
  connectorId: string;
  inputDigest: string;
  status: string;
  cursorEnd: number;
  rowsSeen: number;
  rowsApplied: number;
  rowsSkipped: number;
  rowsRejected: number;
  directFieldsApplied: number;
  regulatedFieldsProposed: number;
  rejectionReasons: unknown[];
  replayOfRunId: string | null;
  [key: string]: unknown;
};

type StoredProposal = {
  id: string;
  payload: { values: Record<string, string> };
  [key: string]: unknown;
};

function makeDb() {
  const runs: StoredRun[] = [];
  const proposals: StoredProposal[] = [];
  const connector = {
    id: 'connector-1',
    organizationId: 'org-a',
    key: 'manual-file',
    label: 'Manual CSV / Excel',
    adapter: 'MANUAL_FILE',
    enabled: true,
    schedule: { kind: 'MANUAL' },
    cursor: null,
    lastRunState: null,
    lastRunAt: null,
    createdBy: 'admin-a',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const target = {
    id: 'medicine-a',
    productName: 'Old name',
    brandName: 'Old brand',
    manufacturer: 'Old maker',
    drapRegistrationNumber: 'old-registration',
    rx: false,
    restricted: false,
    controlled: false,
  };
  const db = {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    pharmacyReferenceConnector: {
      upsert: vi.fn().mockResolvedValue(connector),
      update: vi.fn().mockImplementation(async ({ data }) => Object.assign(connector, data)),
    },
    pharmacyReferenceConnectorRun: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          [...runs]
            .reverse()
            .find(
              (run) =>
                run.connectorId === where.connectorId &&
                run.inputDigest === where.inputDigest &&
                run.status === where.status
            )
        ),
      create: vi.fn().mockImplementation(async ({ data }) => {
        const created = {
          id: `run-${runs.length + 1}`,
          organizationId: 'org-a',
          cursorStart: 0,
          cursorEnd: 0,
          rowsSeen: 0,
          rowsApplied: 0,
          rowsSkipped: 0,
          rowsRejected: 0,
          directFieldsApplied: 0,
          regulatedFieldsProposed: 0,
          rejectionReasons: [],
          startedAt: new Date(),
          completedAt: null,
          error: null,
          replayOfRunId: null,
          status: 'RUNNING',
          ...data,
        };
        runs.push(created);
        return created;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }) => {
        const current = runs.find((run) => run.id === where.id)!;
        return Object.assign(current, data);
      }),
    },
    pharmacyReferenceConnectorProposal: {
      create: vi.fn().mockImplementation(async ({ data }) => {
        const created = { id: `proposal-${proposals.length + 1}`, ...data, status: 'PENDING' };
        proposals.push(created);
        return created;
      }),
    },
    medicine: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) => (where.id === target.id ? { ...target } : null)),
      findMany: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.drapRegistrationNumber === target.drapRegistrationNumber ? [{ ...target }] : []
        ),
      update: vi.fn().mockImplementation(async ({ data }) => Object.assign(target, data)),
    },
  };
  return { db: db as unknown as ScopedDb, runs, proposals, target, raw: db };
}

const runInput = (rows: NormalizedMedicineReferenceRow[]) => ({
  organizationId: 'org-a',
  actorId: 'admin-a',
  triggerKind: 'MANUAL' as const,
  batchId: 'batch-1',
  fileName: 'catalog.csv',
  rows,
});

let fixture = makeDb();

beforeEach(() => {
  fixture = makeDb();
});

describe('manual reference connector automation', () => {
  it('refuses a disabled connector as a refusal the operator reads, writing no run', async () => {
    fixture.raw.pharmacyReferenceConnector.upsert.mockResolvedValue({
      ...(await fixture.raw.pharmacyReferenceConnector.upsert()),
      enabled: false,
    });
    const refused = runManualReferenceConnector(fixture.db, runInput([]));
    // A deliberate TRPCError, so a production client still reads the sentence.
    await expect(refused).rejects.toBeInstanceOf(TRPCError);
    await expect(refused).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Manual reference connector is disabled.',
    });
    expect(fixture.raw.pharmacyReferenceConnectorRun.create).not.toHaveBeenCalled();
  });

  it('rejects a bad row with reasons without writing medicine or proposal data', async () => {
    const result = await runManualReferenceConnector(
      fixture.db,
      runInput([
        row(
          'bad-1',
          { brandName: 'Unidentified brand' },
          { blockingIssues: ['MISSING_PRODUCT_NAME'] }
        ),
      ])
    );

    expect(result).toMatchObject({ rowsSeen: 1, rowsRejected: 1, proposalRows: 0 });
    expect(result.rejectionReasons).toEqual([
      { rowSourceKey: 'bad-1', reasons: ['MISSING_PRODUCT_NAME'] },
    ]);
    expect(fixture.raw.medicine.update).not.toHaveBeenCalled();
    expect(fixture.proposals).toEqual([]);
  });

  it('holds descriptive, identity and controlled fields as proposals before review', async () => {
    const result = await runManualReferenceConnector(
      fixture.db,
      runInput([
        row(
          'update-1',
          {
            productName: 'Confirmed later',
            brandName: 'Direct brand',
            manufacturer: 'Direct maker',
            drapRegistrationNumber: 'new-registration',
            strength: '500 mg',
            dosageForm: 'tablet',
            pack: '10 tablets',
            controlled: 'true',
          },
          { targetMedicineId: 'medicine-a' }
        ),
      ])
    );

    expect(result).toMatchObject({ rowsApplied: 0, directFieldsApplied: 0, proposalRows: 1 });
    expect(fixture.target).toMatchObject({
      productName: 'Old name',
      brandName: 'Old brand',
      manufacturer: 'Old maker',
      controlled: false,
    });
    expect(fixture.raw.medicine.update).not.toHaveBeenCalled();
    expect(fixture.proposals[0]?.payload.values).toMatchObject({
      brandName: 'Direct brand',
      manufacturer: 'Direct maker',
      productName: 'Confirmed later',
      drapRegistrationNumber: 'new-registration',
      controlled: 'true',
    });
  });

  it('DEV-854: holds a NARCOTICS-class row for pharmacist classification without proposing a flag', async () => {
    const result = await runManualReferenceConnector(
      fixture.db,
      runInput([
        row(
          'legacy-1',
          { productName: 'Sedex 5mg', strength: '5 mg', dosageForm: 'tablet', pack: '10 tablets' },
          { legacyClass: 'NARCOTICS', legacyCategory: 'Tablts' }
        ),
        row('legacy-2', { productName: 'Amoxil' }, { legacyClass: 'Muller & Phipps' }),
      ])
    );

    expect(result).toMatchObject({ proposalRows: 2 });
    const [held, plain] = fixture.proposals as Array<
      StoredProposal & { payload: { controlledReview?: unknown } }
    >;
    expect(held!.payload.controlledReview).toEqual({
      cues: ['LEGACY_CLASS_NARCOTICS'],
      legacyClass: 'NARCOTICS',
      legacyCategory: 'Tablts',
    });
    // The legacy class is a review cue only; it never becomes a controlled value.
    expect(held!.payload.values).not.toHaveProperty('controlled');
    expect(plain!.payload.controlledReview).toBeUndefined();
  });

  it('DEV-854: proposes classification for an unchanged existing medicine with a legacy cue', async () => {
    fixture.target.productName = 'Tramadol 50mg';
    const result = await runManualReferenceConnector(
      fixture.db,
      runInput([row('legacy-3', {}, { targetMedicineId: 'medicine-a' })])
    );
    expect(result).toMatchObject({ proposalRows: 1, rowsSkipped: 0 });
    expect(fixture.proposals[0]).toMatchObject({
      targetMedicineId: 'medicine-a',
      payload: { values: {}, controlledReview: { cues: ['NAME_SUGGESTS_CONTROLLED_SUBSTANCE'] } },
    });
  });

  it('DEV-854: a mapped legacy class changes the input digest; an unmapped one does not', () => {
    const plain = [row('a', { productName: 'X' })];
    expect(manualConnectorInputDigest({ fileName: 'f.csv', rows: plain })).toBe(
      manualConnectorInputDigest({ fileName: 'f.csv', rows: [{ ...plain[0]! }] })
    );
    expect(manualConnectorInputDigest({ fileName: 'f.csv', rows: plain })).not.toBe(
      manualConnectorInputDigest({
        fileName: 'f.csv',
        rows: [{ ...plain[0]!, legacyClass: 'NARCOTICS' }],
      })
    );
  });

  it('records a second identical input as a no-op', async () => {
    const input = runInput([
      row('new-1', {
        productName: 'Paracetamol',
        strength: '500 mg',
        dosageForm: 'tablet',
        pack: '10 tablets',
      }),
    ]);
    await runManualReferenceConnector(fixture.db, input);
    const replay = await runManualReferenceConnector(fixture.db, input);

    expect(replay).toMatchObject({ noOp: true, rowsSeen: 1, rowsSkipped: 1, proposalRows: 0 });
    expect(fixture.proposals).toHaveLength(1);
    expect(fixture.runs).toHaveLength(2);
    expect(fixture.runs[1]?.replayOfRunId).toBe(fixture.runs[0]?.id);
  });

  it('continues the same logical run from its persisted cursor', async () => {
    const rows = Array.from({ length: MAX_CONNECTOR_ROWS_PER_CALL + 1 }, (_, index) =>
      row(`new-${index}`, {
        productName: `Medicine ${index}`,
        strength: '1 mg',
        dosageForm: 'tablet',
        pack: '1 tablet',
      })
    );
    const first = await runManualReferenceConnector(fixture.db, runInput(rows));
    const second = await runManualReferenceConnector(fixture.db, runInput(rows));

    expect(first).toMatchObject({ status: 'RUNNING', cursorEnd: MAX_CONNECTOR_ROWS_PER_CALL });
    expect(second).toMatchObject({ status: 'COMPLETED', cursorEnd: rows.length });
    expect(fixture.runs).toHaveLength(1);
    expect(fixture.proposals).toHaveLength(rows.length);
  });
});

describe('DRAP registry connector automation', () => {
  const drapInput = (rows: NormalizedMedicineReferenceRow[]) => ({
    ...runInput(rows),
    connectorKey: 'drap-registry' as const,
    fileName: 'drap.csv',
  });

  it('matches an existing medicine by registration number and only proposes changes', async () => {
    const result = await runManualReferenceConnector(
      fixture.db,
      drapInput([
        row('drap-old-registration', {
          drapRegistrationNumber: 'old-registration',
          productName: 'Official name',
          brandName: 'Official brand',
          manufacturer: 'Old maker',
          strength: '500 mg',
          dosageForm: 'tablet',
          pack: '10 tablets',
          rx: 'true',
        }),
      ])
    );

    expect(result).toMatchObject({ rowsApplied: 0, directFieldsApplied: 0, proposalRows: 1 });
    expect(fixture.raw.medicine.update).not.toHaveBeenCalled();
    expect(fixture.raw.pharmacyReferenceConnector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_key: { organizationId: 'org-a', key: 'drap-registry' } },
      })
    );
    const proposal = fixture.proposals[0] as unknown as {
      targetMedicineId: string;
      payload: { values: Record<string, string>; source: Record<string, unknown> };
    };
    expect(proposal.targetMedicineId).toBe('medicine-a');
    expect(proposal.payload.values).toEqual({
      productName: 'Official name',
      brandName: 'Official brand',
      strength: '500 mg',
      dosageForm: 'tablet',
      pack: '10 tablets',
      rx: 'true',
    });
    expect(proposal.payload.source).toMatchObject({
      connectorId: 'drap-registry',
      label: 'DRAP registry file',
      rights: DRAP_REGISTRY_RIGHTS,
    });
  });

  it('rejects a registration number that already matches two medicines', async () => {
    fixture.raw.medicine.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    const result = await runManualReferenceConnector(
      fixture.db,
      drapInput([
        row('drap-dup', {
          drapRegistrationNumber: 'dup',
          productName: 'Twin',
          strength: '1 mg',
          dosageForm: 'tablet',
          pack: '10 tablets',
        }),
      ])
    );

    expect(result).toMatchObject({ rowsRejected: 1, proposalRows: 0 });
    expect(result.rejectionReasons).toEqual([
      { rowSourceKey: 'drap-dup', reasons: ['AMBIGUOUS_DRAP_REGISTRATION'] },
    ]);
  });

  it('keeps DRAP and manual uploads of the same rows as separate inputs', async () => {
    const rows = [
      row('same', { productName: 'X', strength: '1 mg', dosageForm: 'tablet', pack: '1 tablet' }),
    ];
    expect(manualConnectorInputDigest(drapInput(rows))).not.toBe(
      manualConnectorInputDigest({ ...drapInput(rows), connectorKey: 'manual-file' })
    );
  });
});
