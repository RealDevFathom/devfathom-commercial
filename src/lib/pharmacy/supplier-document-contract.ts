export const SUPPLIER_DOCUMENT_MAX_MB = 10;
export const SUPPLIER_DOCUMENT_MAX_BYTES = SUPPLIER_DOCUMENT_MAX_MB * 1024 * 1024;
export const SUPPLIER_DOCUMENT_SIZE_MESSAGE = `Choose a file of ${SUPPLIER_DOCUMENT_MAX_MB} MB or smaller.`;
export const SUPPLIER_DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export const SUPPLIER_DOCUMENT_UPLOAD_URL = '/api/pharmacy/supplier-documents/upload';
export const SUPPLIER_DOCUMENT_TOKEN_HEADER = 'x-devfathom-supplier-token';
export const SUPPLIER_ACCESS_HEADER = 'x-devfathom-supplier-access';
