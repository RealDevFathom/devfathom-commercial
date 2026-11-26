import { can, subjectFromSession } from '@/lib/abac';
import { readReconciliation } from '@/lib/pharmacy/migration/abuzar-reconciliation';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { trustedRequestOrigin } from '@/lib/http-origin';
import { readBoundedBody } from '@/lib/http/read-bounded-body';
import { hasModule } from '@/lib/entitlements';
import { createTRPCContext } from '@/server/trpc';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyOwnerImportRouter } from '@/server/routers/pharmacy-owner-import';
import { AbuzarReviewError, phaseInput, runAbuzarStep } from '@/lib/pharmacy/migration/abuzar-run';
import { parsePreparedExport } from '../../../../../tools/abuzar-import/prepared';

const input = phaseInput.extend({
  step: z.enum([...phaseInput.shape.step.options, 'reconcile']),
  branchId: z.string().min(1).max(128),
  confirmed: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const message = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== trustedRequestOrigin(request))
      return message(403, 'Use the signed-in pharmacy workspace.');
    const actor = await resolveTenantActor({ request });
    if (!actor?.session?.user?.id) return message(401, 'Sign in to your pharmacy.');
    const { session, organization } = actor;
    if (session.user.isSupportSession || session.user.organizationId !== organization.id)
      return message(403, 'Pharmacy membership required.');
    const ctx = await createTRPCContext({
      req: request,
      session,
      organization,
      support: actor.support,
    });
    if (
      !hasModule(ctx.entitlements, 'pharmacy-core') ||
      ctx.entitlements.organizationId !== organization.id
    )
      return message(403, 'Pharmacy access required.');
    // Reuse the production owner import gate and its active-branch scope before reading private files.
    const { branches } = await pharmacyOwnerImportRouter.createCaller(ctx).options();
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data;'))
      return message(400, 'Choose the prepared export files.');
    const body = await readBoundedBody(request, 97 * 1024 * 1024);
    if (body === null) return message(413, 'Prepared export exceeds the upload limit.');
    const form = await new Response(new Uint8Array(body), {
      headers: { 'Content-Type': request.headers.get('content-type')! },
    }).formData();
    const selection = form.get('selection');
    if (typeof selection !== 'string' || selection.length > 2048)
      return message(400, 'Choose an import step and branch.');
    const parsed = input.safeParse(JSON.parse(selection));
    if (!parsed.success) return message(400, 'Choose a valid import step and branch.');
    const { branchId, confirmed, ...options } = parsed.data;
    if (!branches.some((b) => b.id === branchId))
      return message(403, 'Choose an active branch in this workspace.');
    if (
      (options.step === 'catalogue' || options.step === 'prices') &&
      !(await can(subjectFromSession(session.user), 'pharmacy:catalogue-edit', undefined, {
        db: ctx.db,
        source: 'REST',
      }))
    )
      return message(403, 'Catalogue edit permission required.');
    let data;
    try {
      data = await parsePreparedExport(async (name, limit) => {
        const entries = form.getAll(name);
        const file = entries[0];
        if (entries.length !== 1 || !(file instanceof File) || file.size > limit)
          throw new Error('Invalid prepared file.');
        return Buffer.from(await file.arrayBuffer());
      });
    } catch {
      return message(400, 'Check the export manifest, files, headers, row counts and checksums.');
    }
    if (options.step === 'reconcile') {
      const report = await ctx.db.$transaction(
        (db) =>
          readReconciliation(
            db as typeof ctx.db,
            organization.id,
            branchId,
            options.sourceBranch,
            data
          ),
        { isolationLevel: 'RepeatableRead', timeout: 60000 }
      );
      return Response.json(report, { headers: { 'Cache-Control': 'no-store' } });
    }
    const selected = phaseInput.parse(options);
    const report = await ctx.db.$transaction(
      (db) =>
        runAbuzarStep(
          db as typeof ctx.db,
          { organizationId: organization.id, branchId, actorId: session.user.id },
          data,
          selected,
          confirmed
        ),
      { isolationLevel: 'Serializable', timeout: 180000 }
    );
    return Response.json(report, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AbuzarReviewError) return message(409, error.message);
    if (
      error instanceof TRPCError &&
      ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'].includes(error.code)
    )
      return message(403, 'Pharmacy administrator access required.');
    if (error instanceof SyntaxError || error instanceof TypeError)
      return message(400, 'Invalid prepared export request.');
    return message(409, 'The step could not complete. Review the current dry run and retry.');
  }
}
