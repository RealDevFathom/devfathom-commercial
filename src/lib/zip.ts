import { crc32 } from 'node:zlib';

export type ZipEntry = { name: string; data: string | Uint8Array };

const UTF8_NAME_FLAG = 0x0800;
// 1980-01-01 00:00 in MS-DOS time: the archive carries no wall-clock timestamps,
// so the same rows always produce byte-identical archives.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const MAX_32 = 0xffffffff;

/**
 * Build an uncompressed (STORE) ZIP archive. Every reader opens STORE, and CSVs
 * need no dependency to pack. Zip64 is out of scope: an archive at or over 4 GiB
 * is refused rather than written corrupt.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.split('/').includes('..')) {
      throw new Error(`Unsafe archive entry name: ${entry.name}`);
    }
    if (seen.has(entry.name)) throw new Error(`Duplicate archive entry: ${entry.name}`);
    seen.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const checksum = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAME_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAME_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
    if (offset > MAX_32) throw new Error('Archive exceeds the 4 GiB ZIP limit.');
  }
  const directory = Buffer.concat(centrals);
  if (entries.length > 0xffff || offset + directory.length > MAX_32) {
    throw new Error('Archive exceeds the ZIP limits.');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
