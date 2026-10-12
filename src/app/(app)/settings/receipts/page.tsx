import type { Metadata } from 'next';
import { ReceiptDesigner } from '@/components/receipts/receipt-designer';

export const metadata: Metadata = { title: 'Receipt designer' };

export default function ReceiptDesignerPage() {
  return <ReceiptDesigner />;
}
