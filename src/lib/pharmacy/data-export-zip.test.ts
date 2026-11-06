// @vitest-environment node
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { buildZip, crc32 } from './data-export-zip';

/** A strict reader for exactly what the writer emits: walks the central directory. */
function readZip(zip: Buffer) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  let cursor = zip.readUInt32LE(end + 16);
  expect(cursor + size).toBe(end);
  const entries: Array<{ name: string; data: Buffer; flags: number; dosDate: number }> = [];
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const dosDate = zip.readUInt16LE(cursor + 14);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    expect(method).toBe(8);
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const localNameLength = zip.readUInt16LE(offset + 26);
    const start = offset + 30 + localNameLength + zip.readUInt16LE(offset + 28);
    const data = inflateRawSync(zip.subarray(start, start + compressedSize));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(checksum);
    entries.push({ name, data, flags, dosDate });
    cursor += 46 + nameLength;
  }
  return entries;
}

describe('owner data export ZIP writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('round-trips every file byte for byte with UTF-8 names', () => {
    const files = [
      { name: 'README.txt', data: Buffer.from('﻿hello\r\n', 'utf8') },
      { name: 'customers.csv', data: Buffer.from('code,customer\r\nc-1,عائشہ\r\n', 'utf8') },
      { name: 'empty.csv', data: Buffer.alloc(0) },
    ];
    const entries = readZip(buildZip(files, new Date('2026-10-31T09:30:10.000Z')));
    expect(entries.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
    entries.forEach((entry, index) => {
      expect(entry.data.equals(files[index]!.data)).toBe(true);
      expect(entry.flags & 0x0800).toBe(0x0800);
      expect(entry.dosDate).toBe(((2026 - 1980) << 9) | (10 << 5) | 31);
    });
  });

  it('refuses duplicate or path-traversal names', () => {
    const at = new Date('2026-10-31T00:00:00.000Z');
    const data = Buffer.from('x');
    expect(() =>
      buildZip(
        [
          { name: 'a.csv', data },
          { name: 'a.csv', data },
        ],
        at
      )
    ).toThrow('Duplicate');
    expect(() => buildZip([{ name: '../a.csv', data }], at)).toThrow('Invalid');
    expect(() => buildZip([{ name: '/a.csv', data }], at)).toThrow('Invalid');
  });
});
