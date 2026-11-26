import { gunzipSync } from 'node:zlib';
import { eligibleOpeningWitness } from '@/lib/pharmacy/migration/abuzar-witness';
import type { Action } from '@/lib/abac';
import { readReconciliation } from '@/lib/pharmacy/migration/abuzar-reconciliation';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { trustedRequestOrigin } from '@/lib/http-origin';
import { readBoundedBody } from '@/lib/http/read-bounded-body';
import { hasModule } from '@/lib/entitlements';
import { assertCapabilities, createTRPCContext } from '@/server/trpc';
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
async function importAccess(request: Request) {
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
  return { ctx, organization, session, branches };
}
export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== trustedRequestOrigin(request))
      return message(403, 'Use the signed-in pharmacy workspace.');
    const access = await importAccess(request);
    if (access instanceof Response) return access;
    const { ctx, organization, session, branches } = access;
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
    const actions: Action[] = ['admin:access', 'reports:financial'];
    if (options.step === 'catalogue' || options.step === 'prices')
      actions.push('pharmacy:catalogue-edit');
    if (options.step === 'stock') actions.push('pharmacy:inventory');
    await assertCapabilities(
      ctx,
      confirmed ? 'pharmacyOwnerImport.commit' : 'pharmacyOwnerImport.preview',
      confirmed ? 'mutation' : 'query',
      actions
    );
    let data;
    try {
      data = await parsePreparedExport(async (name, limit) => {
        const compressed = form.get('encoding') === 'gzip';
        const entries = form.getAll(name);
        const file = entries[0];
        if (
          entries.length !== 1 ||
          !(file instanceof File) ||
          file.size > (compressed ? 4 * 1024 * 1024 : limit)
        )
          throw new Error('Invalid prepared file.');
        const bytes = Buffer.from(await file.arrayBuffer());
        return compressed ? gunzipSync(bytes, { maxOutputLength: limit }) : bytes;
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
    const secret = form.get('witnessSecret');
    if (secret !== null && (typeof secret !== 'string' || secret.length > 128))
      return message(400, 'Invalid witness approval.');
    const selected = phaseInput.parse(options);
    const report = await ctx.db.$transaction(
      (db) =>
        runAbuzarStep(
          db as typeof ctx.db,
          { organizationId: organization.id, branchId, actorId: session.user.id },
          data,
          selected,
          confirmed,
          secret ?? undefined
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

export async function GET(request: Request) {
  try {
    const access = await importAccess(request);
    if (access instanceof Response) return access;
    const { ctx, organization, session, branches } = access;
    const query = new URL(request.url).searchParams,
      branchId = query.get('branch');
    if (!branchId || !branches.some((b) => b.id === branchId))
      return message(403, 'Choose an active branch.');
    if (query.get('list') === 'witnesses') {
      const assigned = await ctx.db.pharmacyBranchAssignment.findMany({
        where: { organizationId: organization.id, branchId, active: true },
        select: { userId: true, user: { select: { name: true } } },
      });
      const witnesses = [];
      for (const member of assigned)
        if (
          await eligibleOpeningWitness(
            ctx.db,
            { organizationId: organization.id, actorId: session.user.id, branchId },
            member.userId
          )
        )
          witnesses.push({ id: member.userId, name: member.user.name });
      return Response.json(witnesses, { headers: { 'Cache-Control': 'no-store' } });
    }
    const document = query.get('document')?.trim(),
      after = query.get('after') ?? '';
    if (!document || document.length > 512 || after.length > 512)
      return message(400, 'Enter the original document number.');
    const rows = await ctx.db.$queryRaw<
      {
        sourceId: string;
        label: string;
        kind: string;
        date: string;
        productCode: string | null;
        quantity: string | null;
        unitPrice: string | null;
        amount: string | null;
      }[]
    >`SELECT "sourceId",label,kind,"documentDate"::text AS date, "productCode",quantity,"unitPrice",amount FROM pharmacy_abuzar_history WHERE "organizationId"=${organization.id} AND "branchId"=${branchId} AND "documentNo"=${document} AND "sourceId">${after} ORDER BY "sourceId" LIMIT 101`;
    return Response.json(
      { rows: rows.slice(0, 100), next: rows.length > 100 ? rows[99]!.sourceId : null },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return message(403, 'Pharmacy administrator access required.');
  }
}
