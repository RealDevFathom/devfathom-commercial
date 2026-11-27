import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { readBoundedJson } from '@/lib/http/read-bounded-body';
import { trustedRequestOrigin } from '@/lib/http-origin';
import { runLearnerCommunityAction, learnerCommunityActions } from '@/lib/university/community';
import {
  PortalError,
  withLearner,
  sendPortalCode,
  verifyPortalCode,
  portalCookie,
  portalHash,
  saveProfile,
} from '@/lib/university/portal';
import {
  beginDocument,
  storeDocumentPart,
  finishDocument,
} from '@/lib/university/portal-documents';
import {
  submitApplication,
  acceptStudentOffer,
  appealGrade,
  appealAdmissionDecision,
  registerStudent,
  withdrawStudent,
  listOpenIntakes,
} from '@/lib/university/academics';
import { cookies } from 'next/headers';
const json = (body: object, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const idSchema = z.string().trim().min(1).max(128);
const draftSchema = z.object({
  intake: idSchema,
  category: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((value) => (value === 'GENERAL' ? undefined : value)),
  qualification: z.string().trim().max(1200),
  equivalence: z.string().trim().max(300),
});
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const origin = request.headers.get('origin');
    if (
      !origin ||
      new URL(origin).origin !== trustedRequestOrigin(request) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return json({ error: 'Invalid origin.' }, 403);
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return json({ error: 'JSON required.' }, 415);
    const { action } = await params;
    const parsed = await readBoundedJson(request, action === 'upload-part' ? 360000 : 8192);
    if (parsed.tooLarge) return json({ error: 'Request is too large.' }, 413);
    const body = z.record(z.string(), z.unknown()).parse(parsed.value);
    if (action === 'sign-in') return json(await sendPortalCode(request, body.email));
    if (action === 'verify') {
      const token = await verifyPortalCode(request, body);
      if (!token) return json({ error: 'The code is incorrect or has expired.' }, 401);
      const response = json({ ok: true });
      response.cookies.set(portalCookie, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 8 * 3600,
      });
      return response;
    }
    const communityAction = learnerCommunityActions.some((item) => item.key === action);
    const moduleKey = communityAction
      ? 'university-services'
      : ['register', 'withdraw', 'appeal'].includes(action)
        ? 'university-academics'
        : action === 'sign-out'
          ? 'university-core'
          : 'university-admissions';
    const result = await withLearner(request, moduleKey, async (ctx, person) => {
      const { db, organizationId: org } = ctx;
      if (communityAction) {
        const inputs = z.record(z.string(), z.string().max(4000)).parse(body);
        try {
          return await runLearnerCommunityAction(ctx, person.id, action, inputs);
        } catch (error) {
          if (error instanceof Error && error.constructor === Error)
            throw new PortalError(400, error.message);
          throw error;
        }
      }
      if (action === 'sign-out') {
        const token = (await cookies()).get(portalCookie)?.value ?? '';
        await db.$executeRaw`DELETE FROM university_portal_sessions WHERE organization_id=${org} AND token_hash=${portalHash(token)} AND expires_at>now()`;
        return;
      }
      if (action === 'profile') return saveProfile(ctx, person, body);
      if (action === 'upload-start') return beginDocument(ctx, body);
      if (action === 'upload-part') return storeDocumentPart(ctx, body);
      if (action === 'upload-finish') return finishDocument(ctx, z.string().uuid().parse(body.id));
      if (action === 'draft' || action === 'submit') {
        const draft = draftSchema.parse(body);
        if (action === 'submit') {
          if (!person.full_name || !person.identity_kind || !draft.qualification)
            throw new PortalError(
              400,
              'Complete your identity and qualification details before submitting.'
            );
          const receipt = await submitApplication(
            ctx,
            person.id,
            draft.intake,
            draft.qualification,
            draft.equivalence,
            draft.category || undefined
          );
          await db.$executeRaw`DELETE FROM university_application_drafts WHERE organization_id=${org} AND person_id=${person.id} AND intake_id=${draft.intake}`;
          return receipt;
        }
        const intake = (await listOpenIntakes(db, org)).find((i) => i.id === draft.intake);
        if (draft.category && !intake?.categories.some((c) => c.id === draft.category))
          throw new PortalError(400, 'Select a category offered for this intake.');
        if (!intake) throw new PortalError(400, 'This intake is closed.');
        await db.$executeRaw`INSERT INTO university_application_drafts(organization_id,person_id,intake_id,qualification,equivalence_reference,category_id) VALUES(${org},${person.id},${draft.intake},${draft.qualification},${draft.equivalence},${draft.category || null}) ON CONFLICT(organization_id,person_id,intake_id) DO UPDATE SET qualification=EXCLUDED.qualification,equivalence_reference=EXCLUDED.equivalence_reference,category_id=EXCLUDED.category_id,updated_at=now()`;
        return;
      }
      const id = idSchema.parse(body.id);
      if (action === 'appeal-admission')
        return appealAdmissionDecision(
          ctx,
          person.id,
          id,
          z.string().trim().min(1).max(1200).parse(body.reason)
        );
      if (action === 'accept') return acceptStudentOffer(ctx, person.id, id);
      if (action === 'register') return registerStudent(ctx, person.id, id);
      if (action === 'withdraw') return withdrawStudent(ctx, person.id, id);
      if (action === 'appeal')
        return appealGrade(
          ctx,
          person.id,
          id,
          z.string().trim().min(1).max(1200).parse(body.reason)
        );
      throw new PortalError(404, 'Unknown portal action.');
    });
    const response = json(result ?? { ok: true });
    if (action === 'sign-out') response.cookies.delete(portalCookie);
    return response;
  } catch (error) {
    if (error instanceof PortalError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
      return json({ error: 'Check the submitted values and try again.' }, 400);
    if (
      error instanceof TRPCError &&
      ['BAD_REQUEST', 'FORBIDDEN', 'CONFLICT', 'NOT_FOUND'].includes(error.code)
    )
      return json({ error: error.message }, 400);
    throw error;
  }
}
