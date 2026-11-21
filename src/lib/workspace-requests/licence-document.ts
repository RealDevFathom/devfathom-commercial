import { crc32, inflateSync, type Inflate } from 'node:zlib';
import sharp from 'sharp';

import { hasPdfStructure } from './pdf-structure';

export const LICENCE_DOCUMENT_REFUSAL =
  'Upload a normal PDF or a JPG or PNG photo. Use a readable file without password protection, scripts, actions that open programs, or embedded files or media.';

export const MAX_LICENCE_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_PNG_RASTER_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CHANNELS = new Map([
  [0, [1, [1, 2, 4, 8, 16]]],
  [2, [3, [8, 16]]],
  [3, [1, [1, 2, 4, 8]]],
  [4, [2, [8, 16]]],
  [6, [4, [8, 16]]],
] as const);

function pngRaster(data: Buffer, header: Buffer): boolean {
  if (header.length !== 13) return false;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const color = header[9] as 0 | 2 | 3 | 4 | 6;
  const format = PNG_CHANNELS.get(color);
  const interlace = header[12];
  if (
    !width ||
    !height ||
    width * height > MAX_IMAGE_PIXELS ||
    !format ||
    !format[1].some((allowed) => allowed === depth) ||
    header[10] !== 0 ||
    header[11] !== 0 ||
    interlace > 1
  )
    return false;
  const [channels] = format;
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const rows = passes
    .map(([x, y, dx, dy]) => ({
      count: Math.max(0, Math.ceil((height - y) / dy)),
      bytes: Math.ceil((Math.max(0, Math.ceil((width - x) / dx)) * channels * depth) / 8),
    }))
    .filter(({ bytes, count }) => bytes > 0 && count > 0);
  const expected = rows.reduce((total, { bytes, count }) => total + (1 + bytes) * count, 0);
  if (expected > MAX_PNG_RASTER_BYTES) return false;
  const { buffer, engine } = inflateSync(data, {
    maxOutputLength: expected,
    info: true,
  }) as unknown as {
    buffer: Buffer;
    engine: Inflate;
  };
  if (buffer.length !== expected || engine.bytesWritten !== data.length) return false;
  let offset = 0;
  for (const { bytes, count } of rows) {
    for (let row = 0; row < count; row++) {
      if (buffer[offset] > 4) return false;
      offset += 1 + bytes;
    }
  }
  return true;
}

function hasPngStructure(bytes: Buffer) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let header: Buffer | undefined;
  let palette = false;
  let idatEnded = false;
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const name = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[a-zA-Z]{2}[A-Z][a-zA-Z]$/.test(name)) return false;
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    const data = bytes.subarray(offset + 8, end - 4);
    if (!header && name !== 'IHDR') return false;
    if (idat.length && name !== 'IDAT') idatEnded = true;
    switch (name) {
      case 'IHDR':
        if (header || length !== 13) return false;
        header = data;
        break;
      case 'PLTE':
        if (palette || idat.length || !length || length % 3 || length > 768 || !header)
          return false;
        if (header[9] === 0 || header[9] === 4 || (header[9] === 3 && length / 3 > 2 ** header[8]))
          return false;
        palette = true;
        break;
      case 'IDAT':
        if (idatEnded || (header?.[9] === 3 && !palette)) return false;
        idat.push(data);
        break;
      case 'IEND':
        return (
          length === 0 &&
          end === bytes.length &&
          header &&
          idat.length > 0 &&
          pngRaster(Buffer.concat(idat), header)
        );
      default:
        // Only a standard single-frame PNG. Reject unknown critical chunks and animation.
        if (!/^[a-z]/.test(name) || ['acTL', 'fcTL', 'fdAT'].includes(name)) return false;
    }
    offset = end;
  }
  return false;
}

const JPEG_FRAMES = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function hasJpegStructure(bytes: Buffer) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let frame = false;
  let scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && scan && offset === bytes.length;
    if (
      marker < 0xc0 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > bytes.length
    )
      return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (JPEG_FRAMES.has(marker)) {
      if (frame || length < 11) return false;
      frame = true;
    }
    offset += length;
    if (marker !== 0xda) continue;
    if (!frame || length < 8) return false;
    scan = true;
    // Entropy bytes may include stuffed FFs and restart markers. Other markers
    // end the scan and are consumed by the segment walk above.
    while (offset < bytes.length) {
      offset = bytes.indexOf(0xff, offset);
      if (offset < 0) return false;
      const start = offset++;
      while (bytes[offset] === 0xff) offset++;
      const next = bytes[offset++];
      if (next !== 0 && !(next >= 0xd0 && next <= 0xd7)) {
        offset = start;
        break;
      }
    }
  }
  return false;
}

export async function verifyLicenceDocument(bytes: Buffer, claimedType: unknown) {
  if (!bytes.length || bytes.length > MAX_LICENCE_FILE_BYTES) return null;
  try {
    switch (claimedType) {
      case 'application/pdf':
        return hasPdfStructure(bytes) ? { type: claimedType, name: 'licence.pdf' } : null;
      case 'image/png':
        if (!hasPngStructure(bytes)) return null;
        break;
      case 'image/jpeg':
        if (!hasJpegStructure(bytes)) return null;
        break;
      default:
        return null;
    }
    // Force decoding of the image, including pixel data that metadata() alone skips.
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS });
    const { format } = await image.metadata();
    const expected = claimedType === 'image/png' ? 'png' : 'jpeg';
    if (format !== expected) return null;
    await image.stats();
    return { type: claimedType, name: claimedType === 'image/png' ? 'licence.png' : 'licence.jpg' };
  } catch {
    return null;
  }
}

/** Decode private stored evidence without trusting its supplied filename. */
export function readStoredLicence(document: unknown) {
  if (!document || typeof document !== 'object') return null;
  const { base64, type, checked } = document as Record<string, unknown>;
  if (
    typeof base64 !== 'string' ||
    base64.length > Math.ceil(MAX_LICENCE_FILE_BYTES / 3) * 4 ||
    (type !== 'application/pdf' && type !== 'image/png' && type !== 'image/jpeg')
  )
    return null;
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_LICENCE_FILE_BYTES || bytes.toString('base64') !== base64)
    return null;
  return { bytes, type, legacy: checked === undefined };
}
