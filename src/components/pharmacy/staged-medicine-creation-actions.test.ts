import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), rows: vi.fn() }));
vi.mock('next/navigation', () => ({ unstable_rethrow: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn(async () => ({})) }));
vi.mock('@/server/routers/pharmacy-medicine', () => ({
  pharmacyMedicineRouter: {
    createCaller: () => ({ runStagedMedicineCreation: mocks.run }),
  },
}));
vi.mock('@/server/routers/pharmacy-staged-review', () => ({
  pharmacyStagedReviewRouter: {
    createCaller: () => ({ pharmacyMedicine: { stagedRows: mocks.rows } }),
  },
}));

import {
  STAGED_CREATION_BUSY,
  STAGED_CREATION_STOPPED,
} from '@/lib/pharmacy/migration/staged-creation';
import {
  readNotCreatedStagedRows,
  runStagedMedicineCreationStep,
} from './staged-medicine-creation-actions';

beforeEach(() => vi.clearAllMocks());

describe('DEV-1002 creation step answers in plain words', () => {
  it('passes the server plain stop and busy messages through', async () => {
    for (const message of [STAGED_CREATION_STOPPED, STAGED_CREATION_BUSY]) {
      mocks.run.mockRejectedValueOnce(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message }));
      expect(await runStagedMedicineCreationStep('batch_1')).toEqual({ error: message });
    }
  });

  it('never shows "Nothing was changed. Try again." or a database message for a step', async () => {
    mocks.run.mockRejectedValueOnce(
      new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Invalid `prisma.medicineAlias.createMany()` invocation: Code: `23514`',
      })
    );
    expect(await runStagedMedicineCreationStep('batch_1')).toEqual({
      error: STAGED_CREATION_STOPPED,
    });
    mocks.run.mockRejectedValueOnce(new Error('connection reset'));
    expect(await runStagedMedicineCreationStep('batch_1')).toEqual({
      error: STAGED_CREATION_STOPPED,
    });
  });

  it('still names the refusals a person can act on', async () => {
    mocks.run.mockRejectedValueOnce(
      new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Creating these medicines needs an approved request first.',
      })
    );
    expect(await runStagedMedicineCreationStep('batch_1')).toEqual({
      error: 'Creating these medicines needs an approved request first.',
    });
    mocks.run.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    expect(await runStagedMedicineCreationStep('batch_1')).toEqual({
      error: 'You need catalogue edit or review permission for this.',
    });
  });

  it('passes the "many rows refused for one reason" stop through in plain words', async () => {
    const message =
      'Creating stopped: many rows were refused for the same reason: a value is not accepted by the catalogue. Nothing was recorded for these rows, and medicines already created are kept. Tell your administrator.';
    mocks.run.mockRejectedValueOnce(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message }));
    expect(await runStagedMedicineCreationStep('batch_1')).toEqual({ error: message });
  });

  it('lists rows not created through the staged review read, first ten only', async () => {
    const selection = { branchId: 'branch_1', sourceId: 'source_1', batchId: 'batch_1' };
    mocks.rows.mockResolvedValueOnce({
      total: 12,
      rows: Array.from({ length: 12 }, (_, index) => ({
        id: `row_${index}`,
        rowNumber: 18_001 + index,
        productName: `Fixture ${index}`,
        notCreatedReason: 'A value in this row is not accepted by the catalogue.',
      })),
    });
    const listed = await readNotCreatedStagedRows(selection);
    expect(mocks.rows).toHaveBeenCalledWith({ ...selection, filter: 'not-created', page: 1 });
    expect('data' in listed && listed.data?.total).toBe(12);
    expect('data' in listed && listed.data?.rows.length).toBe(10);
    expect('data' in listed && listed.data?.rows[0]).toEqual({
      rowId: 'row_0',
      rowNumber: 18_001,
      productName: 'Fixture 0',
      reason: 'A value in this row is not accepted by the catalogue.',
    });
    // Whoever may not read the staged review gets no rows.
    mocks.rows.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    expect(await readNotCreatedStagedRows(selection)).toEqual({
      error: 'You need catalogue edit or review permission for this.',
    });
  });
});
