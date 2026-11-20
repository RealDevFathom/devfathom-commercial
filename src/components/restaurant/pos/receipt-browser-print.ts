import {
  createPrintDocument,
  printInWindow,
  serializePrintDocument,
} from '@/lib/browser-print/print-window';
import type { Receipt } from './receipt-view';

/** Explicit OS-dialog fallback; no afterprint handler and no physical-success claim. */
export function requestReceiptDialog(
  receipt: Receipt,
  width: 58 | 80,
  preview: string
): Promise<void> {
  if (!preview) throw new Error('Validated receipt preview unavailable. Check print status.');
  // DEV-973: an isolated window that prints itself, so the POS never freezes.
  const doc = createPrintDocument(`Receipt ${receipt.receiptNumber ?? 'unissued'}`);
  const style = doc.createElement('style');
  // Shared server preview uses the captured job layout, or current saved layout before enqueue.
  // Unicode logical lines remain intact; browser pre-wrap owns glyph-aware layout.
  // CSS has no custom-width/auto-height page size. The OS dialog owns roll paper size.
  style.textContent = `@page { size: auto; margin: 2mm; } body { width: ${width - 4}mm; margin: 0; font: 10pt monospace; color: black; background: white; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }`;
  doc.head.append(style);
  const content = doc.createElement('pre');
  content.textContent = preview;
  doc.body.replaceChildren(content);
  return printInWindow(serializePrintDocument(doc), {
    features: 'popup,width=420,height=720',
    blockedMessage: 'Print window blocked. Allow popups and retry.',
    failedMessage: 'Print dialog could not be requested.',
  });
}
