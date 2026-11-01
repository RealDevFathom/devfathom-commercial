import { getPlatformSession, canPlatform } from '@/lib/platform/auth';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

/** Evidence is downloadable only by operators who can read the CRM queue. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getPlatformSession(request);
  if (!actor || !canPlatform(actor, 'crm:read'))
    return Response.json({ error: 'Not allowed.' }, { status: 403 });
  const { id } = await params;
  const lead = await withPlatformDb((db) =>
    db.platformLead.findUnique({ where: { id }, select: { notes: true, source: true } })
  );
  if (!lead?.source?.startsWith('workspace-request:') || !lead.notes)
    return Response.json({ error: 'Not found.' }, { status: 404 });
  let intake;
  try {
    intake = JSON.parse(lead.notes);
  } catch {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (new URL(request.url).searchParams.get('document') === '1') {
    const document = intake.document;
    if (!document || !['application/pdf', 'image/png', 'image/jpeg'].includes(document.type))
      return Response.json({ error: 'Not found.' }, { status: 404 });
    return new Response(Buffer.from(document.base64, 'base64'), {
      headers: {
        ...headers,
        'Content-Type': document.type,
        'Content-Disposition': `attachment; filename="${String(document.name).replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
      },
    });
  }
  return Response.json(
    { id, status: 'pending admin review', details: intake.details },
    {
      headers: {
        ...headers,
        'Content-Disposition': 'attachment; filename="workspace-request.json"',
      },
    }
  );
}
