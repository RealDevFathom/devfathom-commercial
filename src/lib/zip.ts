import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

export type ZipEntry = { name: string; data: string | Uint8Array };

const UTF8_NAME_FLAG = 0x0800;
// 1980-01-01 00:00 in MS-DOS time: the archive carries no wall-clock timestamps,
// so the same rows always produce byte-identical archives.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

function checkEntryName(name: string, seen: Set<string>) {
  if (!name || name.startsWith('/') || name.split('/').includes('..')) {
    throw new Error(`Unsafe archive entry name: ${name}`);
  }
  if (seen.has(name)) throw new Error(`Duplicate archive entry: ${name}`);
  seen.add(name);
}

function localHeader(name: Buffer, checksum: number, size: number): Buffer {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(UTF8_NAME_FLAG, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  return local;
}

function centralHeader(name: Buffer, checksum: number, size: number, offset: number): Buffer {
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(UTF8_NAME_FLAG, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  return central;
}

function endRecord(count: number, directoryLength: number, directoryOffset: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directoryLength, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return end;
}

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
    checkEntryName(entry.name, seen);
    const name = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const checksum = crc32(data) >>> 0;
    locals.push(
      localHeader(name, checksum, data.length),
      name,
      Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    );
    centrals.push(centralHeader(name, checksum, data.length, offset), name);
    offset += 30 + name.length + data.length;
    if (offset > MAX_32) throw new Error('Archive exceeds the 4 GiB ZIP limit.');
  }
  const directory = Buffer.concat(centrals);
  if (entries.length > MAX_ENTRIES || offset + directory.length > MAX_32) {
    throw new Error('Archive exceeds the ZIP limits.');
  }
  return Buffer.concat([...locals, directory, endRecord(entries.length, directory.length, offset)]);
}

/** Thrown when a streamed archive would grow past its size cap. */
export class ZipSizeLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Archive exceeds the ${maxBytes}-byte size limit.`);
    this.name = 'ZipSizeLimitError';
  }
}

/**
 * Stream a STORE archive to a file, one entry at a time, so no entry and no
 * archive is ever held in memory whole. Each entry's local header is written
 * first with a zero CRC and size, the data is streamed after it, and the header
 * is then patched in place, so the result is byte-identical to `buildZip` for
 * the same entries (no data descriptors). Writing stops with `ZipSizeLimitError`
 * as soon as the file would pass `maxBytes`.
 */
export class ZipFileWriter {
  private offset = 0;
  private readonly centrals: Buffer[] = [];
  private readonly seen = new Set<string>();
  private count = 0;
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly maxBytes: number
  ) {}

  /** Create a new file; an existing file at `path` is never overwritten. */
  static async create(path: string, options: { maxBytes?: number } = {}): Promise<ZipFileWriter> {
    const maxBytes = Math.min(options.maxBytes ?? MAX_32, MAX_32);
    return new ZipFileWriter(await open(path, 'wx', 0o600), maxBytes);
  }

  /** Bytes written to the file so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  private async write(data: Uint8Array, position: number) {
    let written = 0;
    while (written < data.length) {
      const { bytesWritten } = await this.handle.write(
        data,
        written,
        data.length - written,
        position + written
      );
      written += bytesWritten;
    }
  }

  private reserve(bytes: number) {
    if (this.offset + bytes > this.maxBytes) throw new ZipSizeLimitError(this.maxBytes);
  }

  /** Append one entry, streaming its chunks to disk. Returns the entry's data size. */
  async addEntry(
    entryName: string,
    chunks: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>
  ): Promise<number> {
    if (this.closed) throw new Error('Archive is already closed.');
    checkEntryName(entryName, this.seen);
    if (this.count + 1 > MAX_ENTRIES) throw new Error('Archive exceeds the ZIP limits.');
    const name = Buffer.from(entryName, 'utf8');
    const start = this.offset;
    this.reserve(30 + name.length);
    await this.write(Buffer.concat([localHeader(name, 0, 0), name]), start);
    this.offset += 30 + name.length;

    let checksum = 0;
    let size = 0;
    for await (const chunk of chunks) {
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (data.length === 0) continue;
      this.reserve(data.length);
      await this.write(data, this.offset);
      checksum = crc32(data, checksum);
      size += data.length;
      this.offset += data.length;
    }
    checksum >>>= 0;
    // Patch CRC-32, compressed size and uncompressed size (offsets 14..26).
    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(checksum, 0);
    patch.writeUInt32LE(size, 4);
    patch.writeUInt32LE(size, 8);
    await this.write(patch, start + 14);
    this.centrals.push(centralHeader(name, checksum, size, start), name);
    this.count += 1;
    return size;
  }

  /** Write the central directory and close the file. Returns the archive size. */
  async close(): Promise<number> {
    if (this.closed) throw new Error('Archive is already closed.');
    const directory = Buffer.concat(this.centrals);
    const end = endRecord(this.count, directory.length, this.offset);
    this.reserve(directory.length + end.length);
    await this.write(Buffer.concat([directory, end]), this.offset);
    this.offset += directory.length + end.length;
    this.closed = true;
    await this.handle.close();
    return this.offset;
  }

  /** Close the file without finishing it; the caller deletes the partial file. */
  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}
