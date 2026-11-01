import type { Metadata } from 'next';
import { HostedReceiptView } from './receipt-view';

export const metadata: Metadata = {
  title: 'Pharmacy receipt',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function HostedReceiptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <HostedReceiptView token={token} />;
}
