// @vitest-environment node
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip } from './zip';

/** Read a STORE archive back through its central directory, checking every CRC. */
function readZip(archive: Buffer): Map<string, Buffer> {
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const checksum = archive.readUInt32LE(cursor + 16);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const start = localOffset + 30 + localNameLength;
    const data = archive.subarray(start, start + size);
    expect(crc32(data) >>> 0).toBe(checksum);
    files.set(name, data);
    cursor += 46 + nameLength;
  }
  return files;
}

describe('buildZip', () => {
  it('writes every entry so a reader gets the same bytes back', () => {
    const archive = buildZip([
      { name: 'README.md', data: '# Export\n' },
      { name: 'customers.csv', data: '"code","customer"\r\n"c1","Ayesha — خان"\r\n' },
      { name: 'empty.csv', data: '' },
    ]);
    const files = readZip(archive);
    expect([...files.keys()]).toEqual(['README.md', 'customers.csv', 'empty.csv']);
    expect(files.get('customers.csv')!.toString('utf8')).toContain('Ayesha — خان');
    expect(files.get('empty.csv')!.length).toBe(0);
  });

  it('is deterministic for the same input', () => {
    const entries = [{ name: 'a.csv', data: 'x' }];
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true);
  });

  it('refuses unsafe or duplicate names', () => {
    expect(() => buildZip([{ name: '../evil.csv', data: '' }])).toThrow(/Unsafe/);
    expect(() => buildZip([{ name: '/abs.csv', data: '' }])).toThrow(/Unsafe/);
    expect(() =>
      buildZip([
        { name: 'a.csv', data: '' },
        { name: 'a.csv', data: '' },
      ])
    ).toThrow(/Duplicate/);
  });
});
