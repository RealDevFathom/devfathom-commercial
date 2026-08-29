import type { PrintDocument } from './contract';

const ESC = 0x1b;
const GS = 0x1d;
const encoder = new TextEncoder();

function text(value: string): number[] {
  return [...encoder.encode(value.replace(/[^\x20-\x7e\n]/g, '?'))];
}

/** Vendor-neutral ESC/POS baseline: initialize, centered bold header, left-aligned body, cut. */
export function renderEscPos(document: PrintDocument): Uint8Array {
  const out: number[] = [ESC, 0x40, ESC, 0x61, 0x01, ESC, 0x45, 0x01];
  out.push(...text(`${document.title}\n${document.reference}\n`));
  out.push(ESC, 0x45, 0x00, ESC, 0x61, 0x00, ...text('--------------------------------\n'));
  for (const line of document.lines) out.push(...text(`${line.quantity} x ${line.label}\n`));
  if (document.footer) out.push(...text(`--------------------------------\n${document.footer}\n`));
  out.push(...text('\n\n\n'), GS, 0x56, 0x00);
  return Uint8Array.from(out);
}
