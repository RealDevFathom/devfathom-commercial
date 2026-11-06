import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/restaurant/bills', () => ({ reverseCompLine: vi.fn() }));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  reverseCompBody: {},
  moneyMutationRoute: (configuration: unknown) => configuration,
  requireBillInDeviceBranch: vi.fn(),
  resolveApprover: vi.fn(),
}));

import { reverseCompLine } from '@/lib/restaurant/bills';
import {
  requireBillInDeviceBranch,
  resolveApprover,
  reverseCompBody,
  type MoneyCommandArgs,
} from '@/lib/restaurant/checkout-routes';
import { POST } from './route';

const run = (
  POST as unknown as {
    run: (args: MoneyCommandArgs<typeof reverseCompBody>) => Promise<unknown>;
  }
).run;
const args = {
  ctx: { db: {}, device: { branchId: 'branch-local' }, session: { id: 'session' } },
  data: { billId: 'bill', billLineId: 'line', reason: 'mistaken comp', approving: {} },
  actor: { staffProfileId: 'operator', deviceId: 'device', idempotencyKey: 'key' },
  now: new Date(),
} as unknown as MoneyCommandArgs<typeof reverseCompBody>;

describe('checkout comp reversal route authorization', () => {
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
      expect(reverseCompLine).not.toHaveBeenCalled();
    }
  );

  it('returns the approver failure without reversing the comp', async () => {
    vi.mocked(requireBillInDeviceBranch).mockResolvedValue(true);
    const response = new NextResponse(null, { status: 403 });
    vi.mocked(resolveApprover).mockResolvedValue({ ok: false, response });
    expect(await run(args)).toBe(response);
    expect(resolveApprover).toHaveBeenCalledWith(args.ctx, args.data.approving, args.now);
    expect(reverseCompLine).not.toHaveBeenCalled();
  });

  it('reverses the comp with the authenticated approver, branch, and terminal session', async () => {
    vi.mocked(requireBillInDeviceBranch).mockResolvedValue(true);
    vi.mocked(resolveApprover).mockResolvedValue({
      ok: true,
      staffProfileId: 'approving-manager',
    });
    const result = { billId: 'bill', billLineId: 'line', replayed: false };
    vi.mocked(reverseCompLine).mockResolvedValue(result);

    expect(await run(args)).toBe(result);

    expect(reverseCompLine).toHaveBeenCalledWith(
      args.ctx.db,
      expect.objectContaining({
        billId: 'bill',
        branchId: 'branch-local',
        billLineId: 'line',
        reason: 'mistaken comp',
        approvingStaffProfileId: 'approving-manager',
        terminalSessionId: 'session',
        actor: args.actor,
      })
    );
  });

  it('gates the acting operator on orders:complimentary', () => {
    expect(POST).toMatchObject({ capability: 'orders:complimentary' });
  });
});
