import type { Metadata } from 'next';
import { ClientsContent } from './clients-content';

export const metadata: Metadata = {
  title: 'Clients',
};

export default function ClientsPage() {
  return <ClientsContent />;
}
