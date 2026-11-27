import {
  withUniversityStaff,
  canAccessOffice,
  UniversityAccessError,
} from '@/lib/university/access';
import { admissionsOffice } from '@/lib/university/academics';
import { downloadDocument } from '@/lib/university/portal-documents';
import { PortalError } from '@/lib/university/portal';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    person = new URL(request.url).searchParams.get('person') ?? '';
  try {
    return await withUniversityStaff(async (ctx) => {
      if (!canAccessOffice(ctx, admissionsOffice)) throw new UniversityAccessError();
      return downloadDocument(ctx, id, person, 'staff');
    });
  } catch (e) {
    if (e instanceof PortalError || e instanceof UniversityAccessError)
      return new Response('Document unavailable.', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    throw e;
  }
}
