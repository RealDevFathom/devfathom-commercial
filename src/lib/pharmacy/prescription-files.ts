import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import sharp from 'sharp';
import { z } from 'zod';
import { deleteUpload, getUpload, putUpload } from '@/lib/storage';

export const MAX_PRESCRIPTION_FILE_BYTES = 5 * 1024 * 1024;
const maxBase64Length = 4 * Math.ceil(MAX_PRESCRIPTION_FILE_BYTES / 3);
const contentTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const referencePattern = new RegExp(`^/api/pharmacy/prescription-files\\?id=(${uuid})$`);

export const prescriptionFileRefSchema = z.string().regex(referencePattern);
export const prescriptionUploadSchema = z
  .object({
    patientId: z.string().trim().min(1).max(128),
    contentType: contentTypeSchema,
    dataBase64: z.string().min(1).max(maxBase64Length),
  })
  .strict();

const storedFileSchema = prescriptionUploadSchema.extend({
  version: z.literal(1),
  id: z.string().uuid(),
  organizationId: z.string().min(1),
  uploadedByUserId: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type PrescriptionUpload = z.infer<typeof prescriptionUploadSchema>;
export type PrescriptionUploadReceipt = {
  sourceFileRef: string;
  url: string;
  size: number;
  contentType: PrescriptionUpload['contentType'];
};

// Nested private namespace cannot be addressed by shared /api/files/[name],
// whose filename validation rejects separators and traversal. No public copy.
function namespace(organizationId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(organizationId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace unavailable.' });
  }
  return `${organizationId}/pharmacy-prescriptions`;
}

export function prescriptionFileId(sourceFileRef: string) {
  const match = referencePattern.exec(sourceFileRef);
  if (!match)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Upload a prescription image first.' });
  return match[1];
}

function decode(dataBase64: string) {
  const bytes = Buffer.from(dataBase64, 'base64');
  if (
    !bytes.length ||
    bytes.length > MAX_PRESCRIPTION_FILE_BYTES ||
    bytes.toString('base64') !== dataBase64
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Image must be valid base64 and at most 5 MiB.',
    });
  }
  return bytes;
}

async function validateImage(bytes: Buffer, contentType: PrescriptionUpload['contentType']) {
  try {
    const image = sharp(bytes, { limitInputPixels: 25_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (`image/${metadata.format}` !== contentType || (metadata.pages ?? 1) !== 1)
      throw new Error();
    // Decode the pixels too: a matching header alone is not evidence of an image.
    await image.stats();
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Provide a valid, single-frame PNG, JPEG or WebP image (maximum 25 megapixels).',
    });
  }
}

export async function persistPrescriptionFile(
  organizationId: string,
  uploadedByUserId: string,
  input: PrescriptionUpload,
  fileId: string = randomUUID()
): Promise<PrescriptionUploadReceipt> {
  const parsed = prescriptionUploadSchema.parse(input);
  const bytes = decode(parsed.dataBase64);
  await validateImage(bytes, parsed.contentType);
  const id = z.string().uuid().parse(fileId);
  const stored = {
    ...parsed,
    version: 1,
    id,
    organizationId,
    uploadedByUserId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  try {
    await putUpload(
      namespace(organizationId),
      `${id}.json`,
      Buffer.from(JSON.stringify(stored)),
      'application/json'
    );
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Prescription upload failed. Retry the upload.',
    });
  }
  const url = `/api/pharmacy/prescription-files?id=${id}`;
  return { sourceFileRef: url, url, size: bytes.length, contentType: parsed.contentType };
}

/** Used only for a staged portal upload that was never linked to a request. */
export async function deletePrescriptionFile(organizationId: string, sourceFileRef: string) {
  await deleteUpload(namespace(organizationId), `${prescriptionFileId(sourceFileRef)}.json`);
}

export async function loadPrescriptionFile(organizationId: string, sourceFileRef: string) {
  const id = prescriptionFileId(sourceFileRef);
  const storageNamespace = namespace(organizationId);
  let raw: Buffer;
  try {
    raw = await getUpload(storageNamespace, `${id}.json`);
  } catch (error) {
    const missing = error as { code?: string; statusCode?: number };
    if (
      missing.code === 'ENOENT' ||
      missing.code === 'BlobNotFound' ||
      missing.statusCode === 404
    ) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Prescription image unavailable. Upload it again.',
      });
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Prescription storage unavailable. Retry later.',
    });
  }
  try {
    if (raw.length > maxBase64Length + 4096) throw new Error();
    const stored = storedFileSchema.parse(JSON.parse(raw.toString('utf8')));
    const bytes = decode(stored.dataBase64);
    if (
      stored.organizationId !== organizationId ||
      stored.id !== id ||
      stored.sha256 !== createHash('sha256').update(bytes).digest('hex')
    )
      throw new Error();
    await validateImage(bytes, stored.contentType);
    return { ...stored, bytes };
  } catch {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Prescription image unavailable. Upload it again.',
    });
  }
}
