import { crc32, deflateSync, inflateSync } from 'node:zlib';

/** Upper bound for one evidence still as transferred and stored. */
export const CAMERA_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** A still wider or taller than this is not a camera frame we asked for. */
export const CAMERA_SNAPSHOT_MAX_DIMENSION = 4096;
/**
 * Decompressed scanline budget; bounds the synchronous work and memory a hostile
 * PNG can cause. 4096×2048 RGBA8 fits; the gateway scales stills to ≤1920 wide.
 */
const MAX_RAW_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 4096;

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Channels per pixel for each PNG colour type, and the bit depths it allows. */
const COLOUR_TYPES: Record<number, { channels: number; depths: readonly number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

export type PngStillInfo = { width: number; height: number };

type DecodedPng = PngStillInfo & { header: Buffer; palette: Buffer | null; raw: Buffer };

/**
 * Structural and decode check for one non-interlaced PNG still.
 *
 * Gateway bytes are untrusted. A still is accepted only if it is a complete
 * PNG: signature, IHDR first, valid CRC on every chunk, contiguous IDAT that
 * inflates to exactly the scanline size the header promises (bounded, so a
 * decompression bomb cannot exhaust memory), legal row filters, and a final
 * IEND with nothing after it. Returns null for anything else. It never throws
 * and never reports what it saw, so callers cannot leak gateway output.
 */
export function inspectPngStill(bytes: unknown): PngStillInfo | null {
  const decoded = decodePngStill(bytes);
  return decoded && { width: decoded.width, height: decoded.height };
}

function decodePngStill(bytes: unknown): DecodedPng | null {
  try {
    if (!(bytes instanceof Uint8Array)) return null;
    if (bytes.byteLength <= SIGNATURE.length || bytes.byteLength > CAMERA_SNAPSHOT_MAX_BYTES)
      return null;
    const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!png.subarray(0, 8).equals(SIGNATURE)) return null;

    let offset = 8;
    let header: { width: number; height: number; depth: number; colour: number } | null = null;
    let palette: Buffer | null = null;
    let headerBytes: Buffer | null = null;
    let ended = false;
    let idatState: 'none' | 'open' | 'closed' = 'none';
    const idat: Buffer[] = [];

    for (let count = 0; offset < png.length; count++) {
      if (count >= MAX_CHUNKS || ended || offset + 12 > png.length) return null;
      const length = png.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (length > png.length || end > png.length) return null;
      const type = png.toString('latin1', offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(type)) return null;
      const data = png.subarray(offset + 8, offset + 8 + length);
      if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(end - 4))
        return null;

      if (count === 0) {
        if (type !== 'IHDR' || length !== 13) return null;
        const width = data.readUInt32BE(0);
        const height = data.readUInt32BE(4);
        const [depth, colour, compression, filter, interlace] = data.subarray(8, 13);
        const rule = COLOUR_TYPES[colour];
        if (
          width < 1 ||
          height < 1 ||
          width > CAMERA_SNAPSHOT_MAX_DIMENSION ||
          height > CAMERA_SNAPSHOT_MAX_DIMENSION ||
          !rule ||
          !rule.depths.includes(depth) ||
          compression !== 0 ||
          filter !== 0 ||
          // Adam7 output is rare for a camera still and not worth decoding.
          interlace !== 0
        )
          return null;
        header = { width, height, depth, colour };
        headerBytes = data;
      } else if (type === 'IHDR') {
        return null;
      } else if (type === 'PLTE') {
        if (idatState !== 'none' || length === 0 || length % 3 !== 0) return null;
        palette = data;
      } else if (type === 'IDAT') {
        if (idatState === 'closed') return null;
        idatState = 'open';
        idat.push(data);
      } else if (type === 'IEND') {
        if (length !== 0) return null;
        ended = true;
      } else {
        // Any other critical (upper-case first letter) chunk is unsupported.
        if (type.charCodeAt(0) < 97) return null;
      }
      if (type !== 'IDAT' && idatState === 'open') idatState = 'closed';
      offset = end;
    }

    if (!header || !headerBytes || !ended || idat.length === 0) return null;
    if (header.colour === 3 && !palette) return null;

    const rule = COLOUR_TYPES[header.colour];
    const rowBytes = Math.ceil((header.width * rule.channels * header.depth) / 8);
    const expected = header.height * (rowBytes + 1);
    if (expected > MAX_RAW_BYTES) return null;
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
    if (raw.length !== expected) return null;
    for (let row = 0; row < header.height; row++) {
      if (raw[row * (rowBytes + 1)] > 4) return null;
    }
    return {
      width: header.width,
      height: header.height,
      header: headerBytes,
      palette: header.colour === 3 ? palette : null,
      raw,
    };
  } catch {
    return null;
  }
}

export function isAcceptableCameraSnapshot(bytes: unknown): bytes is Uint8Array {
  return inspectPngStill(bytes) !== null;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Decode a gateway still and re-encode it canonically: IHDR, PLTE (palette
 * images only), one IDAT re-compressed from the validated scanlines, IEND.
 * Every ancillary chunk (text, EXIF, private data) and anything hidden after
 * the zlib stream is dropped, so only image data reaches tenant storage.
 * Returns null when the input is not an acceptable still.
 */
export function normalizePngStill(bytes: unknown): Buffer | null {
  const decoded = decodePngStill(bytes);
  if (!decoded) return null;
  const png = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', decoded.header),
    ...(decoded.palette ? [chunk('PLTE', decoded.palette)] : []),
    chunk('IDAT', deflateSync(decoded.raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.length <= CAMERA_SNAPSHOT_MAX_BYTES ? png : null;
}
