import 'server-only';
import { headers } from 'next/headers';
import { withLearner } from '@/lib/university/portal';
import type { UniversityContext } from '@/lib/university/office-types';

export async function withDelegationSession<T>(work: (ctx: UniversityContext) => Promise<T>) {
  const request = new Request('https://portal.invalid', { headers: await headers() });
  return withLearner(request, 'university-finance', work);
}
