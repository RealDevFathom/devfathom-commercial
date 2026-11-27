import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { permitsUniversityDelivery } from '@/lib/university/delivery-access';
import { readBoundedJson } from '@/lib/http/read-bounded-body';
import { recordEventReceipt } from '@/lib/university/events';

export const GET = withApiAuth('university:integrations:read', async (ctx, request) => {
  const kind = new URL(request.url).searchParams.get('kind') ?? '';
  if (!(await permitsUniversityDelivery(ctx, kind)))
    return NextResponse.json({ error: 'Event topic unavailable.' }, { status: 403 });
  const events = await ctx.db.$queryRaw`
    SELECT id, kind, source_key AS "sourceKey", payload, occurred_at AS "occurredAt" FROM university_events
     WHERE organization_id = ${ctx.organizationId} AND kind = ${kind} AND status = 'PENDING'
     ORDER BY occurred_at, id LIMIT 100`;
  return NextResponse.json(
    { version: 1, events },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
});

const receiptSchema = z
  .object({
    eventId: z.string().uuid(),
    kind: z.string().max(120),
    status: z.enum(['ACKNOWLEDGED', 'FAILED']),
    reference: z.string().trim().min(1).max(200),
  })
  .strict();

export const POST = withApiAuth('university:integrations:write', async (ctx, request) => {
  const body = await readBoundedJson(request, 4096).catch(() => null);
  if (!body || body.tooLarge)
    return NextResponse.json(
      { error: 'Invalid acknowledgment.' },
      { status: body?.tooLarge ? 413 : 400 }
    );
  const parsed = receiptSchema.safeParse(body.value);
  if (!parsed.success)
    return NextResponse.json({ error: 'Invalid acknowledgment.' }, { status: 400 });
  const receipt = parsed.data;
  if (!(await permitsUniversityDelivery(ctx, receipt.kind)))
    return NextResponse.json({ error: 'Event topic unavailable.' }, { status: 403 });
  const [event] = await ctx.db.$queryRaw<{ id: string }[]>`
    SELECT id FROM university_events WHERE organization_id=${ctx.organizationId} AND kind=${receipt.kind} AND id=${receipt.eventId}`;
  if (!event) return NextResponse.json({ error: 'Unknown event.' }, { status: 404 });
  try {
    await recordEventReceipt(ctx, event.id, receipt.status, receipt.reference);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== 'Unknown event or conflicting acknowledgment.'
    )
      throw error;
    return NextResponse.json({ error: 'Conflicting acknowledgment.' }, { status: 409 });
  }
  return NextResponse.json({ version: 1, id: event.id, status: receipt.status });
});
