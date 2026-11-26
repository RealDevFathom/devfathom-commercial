import { createHash } from 'node:crypto';

import { SUPPLIER_DOCUMENT_MAX_BYTES, SUPPLIER_DOCUMENT_TYPES } from './supplier-document-contract';
export type SupplierDocumentType = (typeof SUPPLIER_DOCUMENT_TYPES)[number];
export type SupplierFileScanMode = 'STRUCTURAL' | 'MALWARE_SCANNED';

export class SupplierFileScanError extends Error {}

export interface FileScanner {
  scan(input: { content: Buffer; declaredMimeType: string }): Promise<{
    mode: SupplierFileScanMode;
    mimeType: SupplierDocumentType;
    byteSize: number;
    sha256: string;
  }>;
}

function sniff(content: Buffer): SupplierDocumentType | null {
  if (content.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'application/pdf';
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * Built-in fail-closed scanner for installations without an external provider.
 * It accepts only the supplier-document allow-list after byte-level type
 * verification. Its recorded STRUCTURAL mode prevents later consumers from
 * mistaking this verdict for an antivirus-provider scan.
 */
export const structuralSupplierFileScanner: FileScanner = {
  async scan({ content, declaredMimeType }) {
    if (!content.length || content.length > SUPPLIER_DOCUMENT_MAX_BYTES)
      throw new SupplierFileScanError('Supplier document size is outside the allowed range.');
    const actual = sniff(content);
    if (!actual || actual !== declaredMimeType)
      throw new SupplierFileScanError('Supplier document type does not match its content.');
    return {
      mode: 'STRUCTURAL',
      mimeType: actual,
      byteSize: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  },
};
