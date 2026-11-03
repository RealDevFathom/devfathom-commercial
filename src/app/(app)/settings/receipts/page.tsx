import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ReceiptDesigner } from '@/components/receipts/receipt-designer';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

export const metadata: Metadata = { title: 'Receipt designer' };

export default async function ReceiptDesignerPage() {
  // Receipt layouts belong to restaurant branches; fail closed for every other vertical.
  const actor = await resolveTenantActor();
  if (actor?.organization.vertical !== 'RESTAURANT') notFound();
  return <ReceiptDesigner />;
}
