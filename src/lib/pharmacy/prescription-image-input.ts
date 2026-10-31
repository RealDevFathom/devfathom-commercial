import type { PrescriptionUpload } from './prescription-files';

// Matches the pharmacy upload contract; its runtime module is server-only.
const maxPrescriptionBytes = 5 * 1024 * 1024;
const evidenceTypes: Record<PrescriptionUpload['contentType'], readonly string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
};

export function isImageType(value: string): value is PrescriptionUpload['contentType'] {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

export function fileError(file: File | null) {
  if (!file || file.size === 0) return 'Choose a non-empty prescription image.';
  if (file.size > maxPrescriptionBytes) return 'Choose a file no larger than 5 MiB.';
  if (
    !isImageType(file.type) ||
    !evidenceTypes[file.type].includes(file.name.split('.').pop()?.toLowerCase() ?? '')
  )
    return 'Use a JPEG, PNG or WebP with a matching file extension.';
  return null;
}

export function imageBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The image could not be read. Select it again.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new Error('The image could not be read. Select it again.'));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
