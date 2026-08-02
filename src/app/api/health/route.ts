import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: 'ok' });
  } catch (error) {
    console.error('[health] database check failed:', error);
    return Response.json({ status: 'unhealthy' }, { status: 503 });
  }
}
