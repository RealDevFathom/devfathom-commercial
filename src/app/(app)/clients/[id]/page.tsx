import type { Metadata } from 'next';
import { ClientDetailContent } from './client-detail-content';

export const metadata: Metadata = {
  title: 'Client',
};

export default async function ClientDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <ClientDetailContent clientId={id} />;
}
