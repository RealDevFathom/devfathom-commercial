import type { Metadata } from 'next';
import { Logo } from '@/components/brand/logo';
import { SupplierPoActionForm } from './supplier-po-action-form';

export const metadata: Metadata = { title: 'Purchase order response' };

export default async function SupplierPoPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <Logo variant="brand" size="md" />
        <SupplierPoActionForm token={token} />
      </div>
    </main>
  );
}
