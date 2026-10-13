import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: 'ok' });
  } catch {
    const reason = 'database_unavailable';
    console.error('[health]', reason);
    return Response.json({ status: 'unhealthy', reason }, { status: 503 });
  }
}
