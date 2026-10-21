import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { readJson } from '@/lib/api-json';
import { withTerminalAuth, type TerminalContext } from './terminal-auth';
import { requireActingOperator, idempotencyKeyFromRequest } from './terminal-orders';
import { resolveCapabilityBranchAuthorization } from './staff-branch-authorization';
import { CateringMoneyError, recordCateringMoneyEvidence } from './catering-money';
import { moneyErrorResponse } from './checkout-routes';

const id = z.string().min(1).max(200);
export const cateringEvidenceBody = z
  .object({
    cateringOrderId: id,
    quoteRevisionId: id,
    kind: z.enum(['DEPOSIT', 'BALANCE', 'REFUND']),
    amount: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    source: z.enum(['CASH', 'OPERATOR_ATTESTED']),
    originalEvidenceId: id.optional(),
    externalEvidenceSource: id.optional(),
    externalEvidenceReference: id.optional(),
    drawerSessionId: id.optional(),
  })
  .strict();

/** Terminal operator/device are resolved by the existing transport, never from JSON. */
export async function recordAuthenticatedCateringEvidence(ctx: TerminalContext, request: Request) {
  if (
    !hasModule(await resolveOrganizationEntitlements(ctx.organizationId, ctx.db), 'restaurant-core')
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Restaurant core is not enabled.' });
  const operator = requireActingOperator(ctx);
  if (!operator.ok) return operator.response;
  const key = idempotencyKeyFromRequest(request);
  if (!key) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Idempotency-Key is required.' });
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const data = cateringEvidenceBody.parse(parsed.data);
  const profile = await ctx.db.restaurantStaffProfile.findFirst({
    where: { id: operator.staffProfileId, organizationId: ctx.organizationId, status: 'ACTIVE' },
    select: { user: { select: { id: true, role: true, department: true, status: true } } },
  });
  // Match existing terminal money policy: a live linked account is required.
  if (!profile?.user || profile.user.status !== 'ACTIVE')
    throw new TRPCError({ code: 'FORBIDDEN' });
  const authorization = await resolveCapabilityBranchAuthorization(
    ctx.db,
    profile.user,
    'catering:manage',
    { organizationId: ctx.organizationId, requireExactlyOneActiveActor: true }
  );
  return Response.json(
    await recordCateringMoneyEvidence(
      ctx.db,
      {
        organizationId: ctx.organizationId,
        branchId: ctx.device.branchId,
        staffProfileId: operator.staffProfileId,
        deviceId: ctx.device.id,
        authorization,
      },
      { ...data, idempotencyKey: key }
    )
  );
}

export const cateringEvidencePost = withTerminalAuth(recordAuthenticatedCateringEvidence, {
  // Mapping happens AFTER the owning transaction has rolled back.
  mapError(error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: 'Invalid catering evidence input.' }, { status: 400 });
    if (error instanceof TRPCError)
      return Response.json(
        { error: error.message },
        { status: error.code === 'BAD_REQUEST' ? 400 : 403 }
      );
    if (error instanceof CateringMoneyError) {
      const denied = /DENIED|MISMATCH|NOT_FOUND/.test(error.reason);
      return Response.json({ error: error.reason }, { status: denied ? 403 : 409 });
    }
    return moneyErrorResponse(error);
  },
});
