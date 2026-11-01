import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/restaurant/bills', () => ({ compLine: vi.fn() }));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  compBody: {},
  moneyMutationRoute: (configuration: unknown) => configuration,
  requireBillInDeviceBranch: vi.fn(),
  resolveApprover: vi.fn(),
}));

import { compLine } from '@/lib/restaurant/bills';
import {
  compBody,
  requireBillInDeviceBranch,
  resolveApprover,
  type MoneyCommandArgs,
} from '@/lib/restaurant/checkout-routes';
import { POST } from './retained-comp-route';

const run = (
  POST as unknown as {
    run: (args: MoneyCommandArgs<typeof compBody>) => Promise<unknown>;
  }
).run;
const args = {
  ctx: { db: {}, device: { branchId: 'branch-local' }, session: { id: 'session' } },
  data: { billId: 'bill', billLineId: 'line', reason: 'complaint', approving: {} },
  actor: {},
  now: new Date(),
} as unknown as MoneyCommandArgs<typeof compBody>;

describe('retained comp domain adapter authorization', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(['missing', 'foreign'])(
    'rejects a %s bill before manager PIN authentication',
    async () => {
      vi.mocked(requireBillInDeviceBranch).mockResolvedValue(false);
      const response = (await run(args)) as Response;
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'The bill does not exist.' });
      expect(requireBillInDeviceBranch).toHaveBeenCalledWith(args.ctx.db, 'bill', 'branch-local');
      expect(resolveApprover).not.toHaveBeenCalled();
      expect(compLine).not.toHaveBeenCalled();
    }
  );

  it('authenticates the approver for a bill in the device branch', async () => {
    vi.mocked(requireBillInDeviceBranch).mockResolvedValue(true);
    const response = new NextResponse(null, { status: 403 });
    vi.mocked(resolveApprover).mockResolvedValue({ ok: false, response });
    expect(await run(args)).toBe(response);
    expect(resolveApprover).toHaveBeenCalledWith(args.ctx, args.data.approving, args.now);
    expect(compLine).not.toHaveBeenCalled();
  });

  it('records the authenticated active terminal session with the comp', async () => {
    vi.mocked(requireBillInDeviceBranch).mockResolvedValue(true);
    vi.mocked(resolveApprover).mockResolvedValue({
      ok: true,
      staffProfileId: 'approving-manager',
    });
    vi.mocked(compLine).mockResolvedValue({
      billLineId: 'line',
      billId: 'bill',
      releasedDiscount: {} as never,
      replayed: false,
    });

    await run(args);

    expect(compLine).toHaveBeenCalledWith(
      args.ctx.db,
      expect.objectContaining({
        billId: 'bill',
        billLineId: 'line',
        approvingStaffProfileId: 'approving-manager',
        terminalSessionId: 'session',
      })
    );
  });

  it('gates the acting operator on orders:complimentary', () => {
    expect(POST).toMatchObject({ capability: 'orders:complimentary' });
  });
});
