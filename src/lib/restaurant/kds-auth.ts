import 'server-only';

import { NextResponse } from 'next/server';
import { staffHasCapability } from './job-roles';
import { withTerminalAuth, type TerminalContext, type TerminalRouteOptions } from './terminal-auth';

/** Re-evaluate branch-scoped kitchen access on every request, including reads. */
export async function requireKitchenOperator(ctx: TerminalContext): Promise<Response | null> {
  const staffId = ctx.session.activeStaffProfileId;
  if (ctx.state !== 'UNLOCKED' || !staffId) {
    return NextResponse.json(
      { error: 'Unlock the display with a kitchen operator PIN.' },
      { status: 401 }
    );
  }
  if (!(await staffHasCapability(ctx.db, staffId, ctx.device.branchId, 'kitchen:operate'))) {
    return NextResponse.json(
      { error: 'Kitchen operation permission is required.' },
      { status: 403 }
    );
  }
  return null;
}

export function withKdsAuth<T extends unknown[]>(
  handler: (ctx: TerminalContext, request: Request, ...args: T) => Promise<Response> | Response,
  options: TerminalRouteOptions = {}
) {
  return withTerminalAuth(async (ctx, request, ...args: T) => {
    const denial = await requireKitchenOperator(ctx);
    if (denial) return denial;
    return handler(ctx, request, ...args);
  }, options);
}
