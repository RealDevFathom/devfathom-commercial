import type { Metadata } from 'next';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { ApiDocsContent } from './api-docs-content';

export const metadata: Metadata = { title: 'API Documentation' };

export default async function ApiDocsPage() {
  const actor = await resolveTenantActor();
  return <ApiDocsContent vertical={actor?.organization.vertical} />;
}
