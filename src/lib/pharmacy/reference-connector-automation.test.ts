import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  MAX_CONNECTOR_ROWS_PER_CALL,
  runManualReferenceConnector,
} from './reference-connector-automation';
import type { NormalizedMedicineReferenceRow } from './reference-connectors';

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
      // Default-catalogue copies matched by product name and manufacturer.
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(async ({ data }) => Object.assign(target, data)),
    },
    // Default-catalogue provenance matched by the row's source key.
    medicineCatalogueProvenance: { findMany: vi.fn().mockResolvedValue([]) },
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

  it('applies descriptive fields but leaves identity and controlled status as proposals', async () => {
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

    expect(result).toMatchObject({ rowsApplied: 1, directFieldsApplied: 2, proposalRows: 1 });
    expect(fixture.target).toMatchObject({
      productName: 'Old name',
      brandName: 'Direct brand',
      manufacturer: 'Direct maker',
      controlled: false,
    });
    expect(fixture.proposals[0]?.payload.values).toMatchObject({
      productName: 'Confirmed later',
      drapRegistrationNumber: 'new-registration',
      controlled: 'true',
    });
  });

  it('targets the catalogue copy holding the row source key instead of a duplicate', async () => {
    Object.assign(fixture.target, { saleable: false, productName: 'PANADOL 500MG TAB' });
    fixture.raw.medicineCatalogueProvenance.findMany.mockResolvedValue([
      { medicineId: 'medicine-a' },
    ]);
    const result = await runManualReferenceConnector(
      fixture.db,
      runInput([
        row('catalog-27', {
          productName: 'PANADOL 500MG TAB',
          drapRegistrationNumber: '012345',
          strength: '500 mg',
          dosageForm: 'Tablet',
          pack: '10 x 10',
        }),
      ])
    );

    expect(fixture.raw.medicineCatalogueProvenance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a', sourceKey: 'catalog-27' } })
    );
    // Source key wins: the name lookup is never needed.
    expect(fixture.raw.medicine.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rowsRejected: 0, proposalRows: 1 });
    expect(fixture.proposals[0]).toMatchObject({ targetMedicineId: 'medicine-a' });
    // An unsaleable copy has nothing reviewed yet: every regulated value is
    // proposed, even the unchanged product name, so it can be published.
    expect(fixture.proposals[0]?.payload.values).toEqual({
      productName: 'PANADOL 500MG TAB',
      drapRegistrationNumber: '012345',
      strength: '500 mg',
      dosageForm: 'Tablet',
      pack: '10 x 10',
    });
  });

  it('falls back to a case-insensitive product name and manufacturer match', async () => {
    fixture.raw.medicine.findMany.mockResolvedValue([{ id: 'medicine-a' }]);
    const result = await runManualReferenceConnector(
      fixture.db,
      runInput([
        row('row-2', {
          productName: '  panadol   500mg tab ',
          manufacturer: 'gsk',
          strength: '500 mg',
          dosageForm: 'Tablet',
          pack: '10 x 10',
        }),
      ])
    );

    expect(fixture.raw.medicine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          productName: { equals: 'panadol 500mg tab', mode: 'insensitive' },
          manufacturer: { equals: 'gsk', mode: 'insensitive' },
          catalogueProvenance: { is: { linkedExisting: false } },
        },
      })
    );
    expect(result).toMatchObject({ proposalRows: 1 });
    expect(fixture.proposals[0]).toMatchObject({ targetMedicineId: 'medicine-a' });
  });

  it('matches a row without a manufacturer only to a copy without one', async () => {
    await runManualReferenceConnector(
      fixture.db,
      runInput([
        row('row-2', {
          productName: 'Brufen',
          strength: '400 mg',
          dosageForm: 'Tablet',
          pack: '1',
        }),
      ])
    );
    expect(fixture.raw.medicine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ manufacturer: null }) })
    );
    // No copy matched: a new-medicine proposal, as before.
    expect(fixture.proposals[0]).toMatchObject({ targetMedicineId: undefined });
  });

  it('refuses a row that matches more than one catalogue copy rather than guessing', async () => {
    fixture.raw.medicine.findMany.mockResolvedValue([{ id: 'copy-1' }, { id: 'copy-2' }]);
    const result = await runManualReferenceConnector(
      fixture.db,
      runInput([row('row-2', { productName: 'Brufen', strength: '400 mg', dosageForm: 'Tablet' })])
    );
    expect(result).toMatchObject({ rowsRejected: 1, proposalRows: 0 });
    expect(result.rejectionReasons).toEqual([
      { rowSourceKey: 'row-2', reasons: ['AMBIGUOUS_CATALOGUE_MATCH'] },
    ]);
    expect(fixture.proposals).toEqual([]);
  });

  it('never looks for a catalogue copy when the row names its target', async () => {
    await runManualReferenceConnector(
      fixture.db,
      runInput([row('row-2', { productName: 'Old name' }, { targetMedicineId: 'medicine-a' })])
    );
    expect(fixture.raw.medicineCatalogueProvenance.findMany).not.toHaveBeenCalled();
    expect(fixture.raw.medicine.findMany).not.toHaveBeenCalled();
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
