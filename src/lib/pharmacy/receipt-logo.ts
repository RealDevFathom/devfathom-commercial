import 'server-only';
import { TRPCError } from '@trpc/server';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { getUpload, putUpload } from '@/lib/storage';

const MAX_BYTES = 1024 * 1024;
export const receiptLogoUpload = z
  .object({
    branchId: z.string().min(1).max(128),
    contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    dataBase64: z
      .string()
      .min(1)
      .max(4 * Math.ceil(MAX_BYTES / 3)),
  })
  .strict();
type Scope = { organizationId: string; branchId: string };
function logoKey(scope: Scope, id: string) {
  return (
    'receipt-logo__' +
    createHash('sha256').update(scope.branchId).digest('hex') +
    '__' +
    z.uuid().parse(id) +
    '.png'
  );
}
export async function uploadReceiptLogo(scope: Scope, input: z.infer<typeof receiptLogoUpload>) {
  const source = Buffer.from(input.dataBase64, 'base64');
  const signature = source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'png'
    : source[0] === 255 && source[1] === 216 && source[2] === 255
      ? 'jpeg'
      : source.toString('ascii', 0, 4) === 'RIFF' && source.toString('ascii', 8, 12) === 'WEBP'
        ? 'webp'
        : null;
  let png: Buffer;
  try {
    if (
      !signature ||
      input.contentType !== 'image/' + signature ||
      source.length > MAX_BYTES ||
      source.toString('base64') !== input.dataBase64
    )
      throw Error();
    const image = sharp(source, { limitInputPixels: 4000000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== signature || (metadata.pages ?? 1) !== 1) throw Error();
    png = await image
      .rotate()
      .resize({ width: 384, height: 240, fit: 'inside', withoutEnlargement: true })
      .png({ palette: true })
      .toBuffer();
    if (png.length > 128 * 1024) throw Error();
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Choose a single PNG, JPEG or WebP up to 1 MiB and 4 megapixels.',
    });
  }
  const assetId = randomUUID();
  await putUpload(scope.organizationId, logoKey(scope, assetId), png, 'image/png');
  return { assetId, png: png.toString('base64') };
}
export async function readReceiptLogo(scope: Scope, assetId: string) {
  const png = await getUpload(scope.organizationId, logoKey(scope, assetId));
  if (
    png.length > 128 * 1024 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw Error('Receipt logo unavailable.');
  return png.toString('base64');
}
