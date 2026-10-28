import qrcode from 'qrcode-generator';
import type { CounterReceipt } from '@/lib/pharmacy/counter-receipt';

/** Only mock-issued numbers are accepted until an official live adapter is enabled. */
export function fiscalReceiptDetails(fiscal: CounterReceipt['fiscal']) {
  if (!fiscal || fiscal.mode !== 'MOCK') return null;
  if (
    fiscal.status !== 'SUBMITTED' ||
    !/^MOCK-FBR-[a-f0-9]{24}$/.test(fiscal.invoiceNumber ?? '')
  ) {
    return { text: 'FBR sandbox submission pending — not a fiscal invoice', qr: null };
  }
  const qr = qrcode(0, 'M');
  // FBR spec: encode the invoice number itself; no invented verification URL.
  qr.addData(fiscal.invoiceNumber!);
  qr.make();
  return {
    text: `FBR sandbox invoice: ${fiscal.invoiceNumber} — not valid for tax verification`,
    qr: `data:image/svg+xml,${encodeURIComponent(qr.createSvgTag({ cellSize: 2, margin: 8, scalable: true }))}`,
  };
}
