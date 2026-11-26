import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  compareRecordedTaxProfiles,
  recordedTaxProfileReviewCsv,
} from '@/lib/pharmacy/accounts/tax-profile-review';
import { recordAudit } from '@/server/audit';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { canReview, reviewContext } from '../_lib/access';

const id = z.string().min(1).max(128);
const selection = z.object({ branch: id, before: id, after: id }).strict();
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const failure = (status: number) =>
  Response.json({ error: 'Tax profile evidence could not be exported.' }, { status, headers });
const errorStatus: Partial<Record<TRPCError['code'], number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
};

export async function GET(request: Request) {
  let ctx: Awaited<ReturnType<typeof reviewContext>> = null;
  let response = failure(500);
  const params = new URL(request.url).searchParams;
  const parsed = selection.safeParse(Object.fromEntries(params));
  const unique = ['branch', 'before', 'after'].every((key) => params.getAll(key).length === 1);
  try {
    ctx = await reviewContext(request);
    if (!ctx || !(await canReview(ctx))) response = failure(403);
    else if (!parsed.success || !unique) response = failure(400);
    else {
      const { branch, before, after } = parsed.data;
      // The existing Finance reader independently checks active session, finance access,
      // licensing and active tenant branch scope on every download.
      const workspace = await pharmacyFinanceRouter
        .createCaller(ctx)
        .workspace({ branchId: branch });
      let review;
      try {
        review = compareRecordedTaxProfiles({
          organizationId: ctx.entitlements.organizationId,
          branchId: branch,
          selectedVersionIds: [before, after],
          profiles: workspace.taxProfiles,
        });
      } catch {
        response = failure(400);
      }
      if (review) {
        response = new Response(recordedTaxProfileReviewCsv(review), {
          headers: {
            ...headers,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="tax-profile-review-v${review.before.versionNumber}-v${review.after.versionNumber}.csv"`,
          },
        });
      }
    }
  } catch (error) {
    response = failure(error instanceof TRPCError ? (errorStatus[error.code] ?? 500) : 500);
  }

  if (ctx) {
    try {
      // Await the scoped write: never release evidence if its audit cannot persist.
      await recordAudit(
        {
          organizationId: ctx.entitlements.organizationId,
          actorType: 'USER',
          actorId: ctx.session?.user.id,
          actorRole: ctx.session?.user.role,
          source: 'SYSTEM',
          category: 'PHARMACY_FINANCE',
          operation: 'READ',
          action: 'pharmacy.taxProfileReview.export',
          path: '/pharmacy/accounts/tax-profile-review/export',
          httpMethod: 'GET',
          statusCode: response.status,
          outcome: response.ok ? 'SUCCESS' : 'FAILURE',
          ip: ctx.requestMeta.ip,
          userAgent: ctx.requestMeta.userAgent,
          metadata: {
            branchId: params.get('branch')?.slice(0, 128) ?? null,
            beforeVersionId: params.get('before')?.slice(0, 128) ?? null,
            afterVersionId: params.get('after')?.slice(0, 128) ?? null,
            attemptedAt: new Date().toISOString(),
            ...(ctx.session?.user.isSupportSession
              ? {
                  supportSessionId: ctx.session.user.supportSessionId,
                  platformUserId: ctx.session.user.platformUserId,
                }
              : {}),
          },
        },
        ctx.db
      );
    } catch {
      return failure(503);
    }
  }
  return response;
}
