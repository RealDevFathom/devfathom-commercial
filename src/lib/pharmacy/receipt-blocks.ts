import {
  ReceiptPreviewFactsSchema,
  wrapReceiptText,
  type ReceiptPreviewFacts,
} from '@/lib/receipts/preview';
import { brandingCaption, receiptDesign, type ReceiptDesign } from './receipt-layout';

export type ReceiptBlock =
  | { kind: 'facts'; text: string }
  | {
      kind: 'text';
      text: string;
      alignment: 'start' | 'center' | 'end';
      emphasis: 'normal' | 'bold' | 'large';
    }
  | { kind: 'website'; url: string; caption: string }
  | { kind: 'logo'; assetId: string; maxWidthMm: number };

/** The caller builds facts from the sale. An optional section can never consume a fact. */
export function receiptBlocks(
  value: unknown,
  facts: ReceiptPreviewFacts,
  mark: string,
  paperWidth: 58 | 80
): ReceiptBlock[] {
  const layout = receiptDesign(value);
  const record = ReceiptPreviewFactsSchema.parse(facts);
  const columns = paperWidth === 58 ? 32 : 48;
  const divider = '-'.repeat(columns);
  const identity = [record.businessName, ...record.taxLines];
  const sale = [
    `${record.invoiceLabel ?? 'Receipt'}: ${record.invoiceNumber}`,
    record.issuedAt,
    divider,
    ...record.lines,
    divider,
    ...record.totals,
    divider,
    ...record.payments,
    mark,
  ];
  const fixed = (lines: string[]): ReceiptBlock => ({
    kind: 'facts',
    text: lines.flatMap((line) => wrapReceiptText(line, columns)).join('\n'),
  });
  const blocks: ReceiptBlock[] = [fixed(identity)];
  const optional = (id: ReceiptDesign['sections'][number]): ReceiptBlock | undefined => {
    if (id === 'logo') return layout.logo && { kind: 'logo', ...layout.logo };
    if (id === 'brandingQr')
      return (
        layout.brandingQr && {
          kind: 'website',
          url: layout.brandingQr.url,
          caption: brandingCaption,
        }
      );
    if (layout[id])
      return {
        kind: 'text',
        text: layout[id],
        alignment: layout.alignment[id],
        emphasis: layout.emphasis[id],
      };
  };
  const sections = layout.sections.flatMap((id) => {
    const block = optional(id);
    return block ? [{ id, block }] : [];
  });
  const additions = sections.map((section) => section.block);
  const footerIndex = sections.findIndex(({ id }) => id === 'brandingQr' || id === 'footerText');
  const beforeSale = footerIndex < 0 ? additions : additions.slice(0, footerIndex);
  // Long branding belongs below the sale. Even a valid header of newlines cannot
  // feed the invoice off the roll. Never discard or shorten a protected field.
  const headerRows = beforeSale.reduce((rows, block) => {
    if (block.kind !== 'text') return rows + 3;
    const large = block.emphasis === 'large';
    const cells = large ? columns / 2 : columns;
    return (
      rows +
      (large ? 2 : 1) *
        block.text
          .split('\n')
          .reduce((n, line) => n + Math.max(1, Math.ceil(Array.from(line).length / cells)), 0)
    );
  }, 0);
  if (headerRows > 8) return [...blocks, fixed(sale), ...additions];
  return [...blocks, ...beforeSale, fixed(sale), ...additions.slice(beforeSale.length)];
}
