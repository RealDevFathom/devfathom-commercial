import { crc32, deflateSync } from 'node:zlib';

/** Test-only PNG builder: valid CRCs and scanlines unless told otherwise. */
export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function makePng(
  options: {
    width?: number;
    height?: number;
    colour?: number;
    depth?: number;
    interlace?: number;
    /** Overrides the inflated scanline bytes. */
    raw?: Buffer;
    /** Ancillary chunk inserted before IEND to reach an exact total size. */
    padTo?: number;
  } = {}
): Buffer {
  const width = options.width ?? 2;
  const height = options.height ?? 2;
  const colour = options.colour ?? 2;
  const depth = options.depth ?? 8;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour] ?? 3;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([depth, colour, 0, 0, options.interlace ?? 0], 8);
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const raw = options.raw ?? Buffer.alloc(height * (rowBytes + 1));
  const parts = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...(colour === 3 ? [pngChunk('PLTE', Buffer.alloc(3))] : []),
    pngChunk('IDAT', deflateSync(raw)),
  ];
  const end = pngChunk('IEND');
  if (options.padTo) {
    const used = parts.reduce((sum, part) => sum + part.length, 0) + end.length + 12;
    parts.push(pngChunk('prVt', Buffer.alloc(options.padTo - used)));
  }
  return Buffer.concat([...parts, end]);
}
