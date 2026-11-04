// @vitest-environment node
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { createSimulatedCameraGateway } from './camera-gateway.simulated';
import {
  CAMERA_SNAPSHOT_MAX_BYTES,
  inspectPngStill,
  isAcceptableCameraSnapshot,
  normalizePngStill,
} from './png-still';
import { makePng, pngChunk } from './png-still.fixtures';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('inspectPngStill', () => {
  it('accepts the simulator still and complete PNGs of every colour type', async () => {
    const simulated = await createSimulatedCameraGateway().getSnapshot('sim-camera-1');
    expect(inspectPngStill(simulated)).toEqual({ width: 1, height: 1 });
    for (const [colour, depth] of [
      [0, 1],
      [0, 16],
      [2, 8],
      [3, 4],
      [4, 8],
      [6, 16],
    ])
      expect(inspectPngStill(makePng({ width: 7, height: 3, colour, depth }))).toEqual({
        width: 7,
        height: 3,
      });
  });

  it('accepts a PNG exactly at the byte limit and refuses one byte more', () => {
    expect(isAcceptableCameraSnapshot(makePng({ padTo: CAMERA_SNAPSHOT_MAX_BYTES }))).toBe(true);
    expect(isAcceptableCameraSnapshot(makePng({ padTo: CAMERA_SNAPSHOT_MAX_BYTES + 1 }))).toBe(
      false
    );
  });

  it.each([
    ['non-byte value', 'iVBORw0KGgo='],
    ['empty bytes', new Uint8Array()],
    ['signature only', SIGNATURE],
    ['JPEG bytes', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])],
    ['HTML error page', Buffer.from('<html>401 rtsp://user:secret@cam</html>')],
    ['HLS manifest', Buffer.from('#EXTM3U\n#EXTINF:2,\nsegment-1.ts\n')],
    ['missing IEND', makePng().subarray(0, -12)],
    ['trailing bytes after IEND', Buffer.concat([makePng(), Buffer.from('x')])],
    ['zero width', makePng({ width: 0 })],
    ['oversized dimension', makePng({ width: 4097, height: 1 })],
    ['interlaced', makePng({ interlace: 1 })],
    ['illegal bit depth', makePng({ colour: 2, depth: 4 })],
    ['short scanlines', makePng({ raw: Buffer.alloc(3) })],
    ['extra scanline data', makePng({ raw: Buffer.alloc(100) })],
    ['illegal row filter', makePng({ width: 1, height: 1, raw: Buffer.from([9, 0, 0, 0]) })],
  ])('refuses %s', (_label, bytes) => {
    expect(inspectPngStill(bytes)).toBeNull();
  });

  it('refuses a corrupted CRC, a missing palette, and an unknown critical chunk', () => {
    const corrupt = makePng();
    corrupt[corrupt.length - 20] ^= 0xff;
    expect(inspectPngStill(corrupt)).toBeNull();

    const header = makePng({ colour: 3, depth: 8 });
    const withoutPalette = Buffer.concat([
      header.subarray(0, 33),
      header.subarray(33 + 12 + 3), // drop the 3-byte PLTE chunk
    ]);
    expect(inspectPngStill(withoutPalette)).toBeNull();

    const base = makePng();
    const critical = Buffer.concat([
      base.subarray(0, 33),
      pngChunk('ZZZZ', Buffer.from('x')),
      base.subarray(33),
    ]);
    expect(inspectPngStill(critical)).toBeNull();
  });

  it('refuses split IDAT runs and bounds a decompression bomb', () => {
    const base = makePng();
    const idat = pngChunk('IDAT', deflateSync(Buffer.alloc(9)));
    const split = Buffer.concat([
      base.subarray(0, 33),
      idat,
      pngChunk('tEXt', Buffer.from('a\0b')),
      idat,
      base.subarray(-12),
    ]);
    expect(inspectPngStill(split)).toBeNull();

    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const bomb = Buffer.concat([
      SIGNATURE,
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(Buffer.alloc(64 * 1024 * 1024))),
      pngChunk('IEND'),
    ]);
    expect(bomb.length).toBeLessThan(CAMERA_SNAPSHOT_MAX_BYTES);
    expect(inspectPngStill(bomb)).toBeNull();
  });

  it('normalizes to image-critical chunks only and drops data hidden after the zlib stream', () => {
    const base = makePng({ width: 3, height: 2 });
    const idatStart = 33;
    const idatLength = base.readUInt32BE(idatStart);
    const idatData = base.subarray(idatStart + 8, idatStart + 8 + idatLength);
    const smuggled = Buffer.concat([
      base.subarray(0, idatStart),
      pngChunk('tEXt', Buffer.from('Comment\0exfiltrated-payload')),
      pngChunk('eXIf', Buffer.from('MM\0*private-metadata')),
      pngChunk('IDAT', Buffer.concat([idatData, Buffer.from('trailing-hidden-bytes')])),
      pngChunk('prVt', Buffer.from('private-chunk')),
      base.subarray(-12),
    ]);
    expect(inspectPngStill(smuggled)).toEqual({ width: 3, height: 2 });
    const normalized = normalizePngStill(smuggled)!;
    for (const marker of [
      'exfiltrated',
      'private-metadata',
      'trailing-hidden',
      'private-chunk',
      'tEXt',
      'eXIf',
    ])
      expect(normalized.includes(Buffer.from(marker))).toBe(false);
    expect(inspectPngStill(normalized)).toEqual({ width: 3, height: 2 });
    expect(normalizePngStill(Buffer.from('<html>'))).toBeNull();
  });

  it('keeps the palette for palette images and the simulator still decodes identically', async () => {
    const paletted = normalizePngStill(makePng({ colour: 3, depth: 8 }))!;
    expect(paletted.includes(Buffer.from('PLTE'))).toBe(true);
    const simulated = await createSimulatedCameraGateway().getSnapshot('sim-camera-1');
    expect(inspectPngStill(normalizePngStill(simulated))).toEqual({ width: 1, height: 1 });
  });
});
