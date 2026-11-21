import { getPlatformSession, canPlatform } from '@/lib/platform/auth';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import {
  readStoredLicence,
  verifyLicenceDocument,
} from '@/lib/workspace-requests/licence-document';

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
  if (!intake || typeof intake !== 'object')
    return Response.json({ error: 'Not found.' }, { status: 404 });
  const headers = {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
  };
  if (new URL(request.url).searchParams.get('document') === '1') {
    const document = readStoredLicence(intake.document);
    if (!document) return Response.json({ error: 'Not found.' }, { status: 404 });
    const verified = await verifyLicenceDocument(document.bytes, document.type);
    // Only evidence received before receipt checks may fall back to a generic
    // attachment. The old type and filename carry no authority in that case.
    if (!verified && !document.legacy)
      return Response.json({ error: 'Not found.' }, { status: 404 });
    const download = verified ?? {
      type: 'application/octet-stream',
      name: 'licence-unverified.bin',
    };
    return new Response(document.bytes, {
      headers: {
        ...headers,
        'Content-Type': download.type,
        'Content-Disposition': `attachment; filename="${download.name}"`,
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
