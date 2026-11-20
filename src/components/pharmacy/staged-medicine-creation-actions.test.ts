import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('next/navigation', () => ({ unstable_rethrow: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn(async () => ({})) }));
vi.mock('@/server/routers/pharmacy-medicine', () => ({
  pharmacyMedicineRouter: {
    createCaller: () => ({ runStagedMedicineCreation: mocks.run }),
  },
}));

import {
  STAGED_CREATION_BUSY,
  STAGED_CREATION_STOPPED,
} from '@/lib/pharmacy/migration/staged-creation';
import { runStagedMedicineCreationStep } from './staged-medicine-creation-actions';

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
});
