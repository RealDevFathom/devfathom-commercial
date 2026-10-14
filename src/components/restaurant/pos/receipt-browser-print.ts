import type { Receipt } from './receipt-view';

/** Explicit OS-dialog fallback; no afterprint handler and no physical-success claim. */
export function requestReceiptDialog(receipt: Receipt, width: 58 | 80, preview: string) {
  if (!preview) throw new Error('Validated receipt preview unavailable. Check print status.');
  const popup = window.open('', '_blank', 'popup,width=420,height=720');
  if (!popup) throw new Error('Print window blocked. Allow popups and retry.');
  popup.opener = null;
  const doc = popup.document;
  doc.title = `Receipt ${receipt.receiptNumber ?? 'unissued'}`;
  const style = doc.createElement('style');
  const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
  if (nonce) style.nonce = nonce;
  // Shared server preview uses the captured job layout, or current saved layout before enqueue.
  // Unicode logical lines remain intact; browser pre-wrap owns glyph-aware layout.
  // CSS has no custom-width/auto-height page size. The OS dialog owns roll paper size.
  style.textContent = `@page { size: auto; margin: 2mm; } body { width: ${width - 4}mm; margin: 0; font: 10pt monospace; color: black; background: white; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }`;
  doc.head.append(style);
  const content = doc.createElement('pre');
  content.textContent = preview;
  doc.body.replaceChildren(content);
  popup.focus();
  popup.print();
}
