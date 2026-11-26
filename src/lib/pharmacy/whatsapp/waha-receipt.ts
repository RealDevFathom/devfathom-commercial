import { HOSTED_RECEIPT_TOKEN_PATTERN } from '../hosted-receipt';
import { WhatsAppProviderError } from './provider';

/** A portable receipt reference. Itemized lines stay on the existing expiring receipt page. */
export function receiptReferencePdf(receiptNumber: string, link: string) {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new WhatsAppProviderError('WAHA_POLICY');
  }
  const path = url.pathname.split('/');
  if (
    !/^\d{1,20}$/.test(receiptNumber) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    path.length !== 3 ||
    path[1] !== 'receipt' ||
    !HOSTED_RECEIPT_TOKEN_PATTERN.test(path[2])
  )
    throw new WhatsAppProviderError('WAHA_POLICY');

  const stream =
    'BT /F1 18 Tf 50 230 Td (Pharmacy receipt ' +
    receiptNumber +
    ') Tj 0 -40 Td /F1 12 Tf (Open the itemized receipt) Tj ET';
  // Encode the URI as a PDF hex string. PDF syntax never interpolates a supplied URL.
  const uri = Buffer.from(url.href, 'utf8').toString('hex');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Annot /Subtype /Link /Rect [48 185 210 207] /Border [0 0 1] /A << /S /URI /URI <${uri}> >> >>`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}
