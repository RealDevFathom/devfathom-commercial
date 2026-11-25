import { PortalError, withLearner } from '@/lib/university/portal';
import { downloadDocument } from '@/lib/university/portal-documents';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return await withLearner(request, 'university-admissions', (ctx, person) =>
      downloadDocument(ctx, id, person.id, 'learner')
    );
  } catch (error) {
    if (error instanceof PortalError)
      return new Response(error.message, {
        status: error.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    throw error;
  }
}
