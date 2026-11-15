// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildZip, ZipFileWriter, ZipSizeLimitError } from './zip';

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

describe('ZipFileWriter', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zip-writer-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function* chunks(...parts: string[]) {
    for (const part of parts) yield part;
  }

  it('streams entries chunk by chunk into the same bytes buildZip writes', async () => {
    const path = join(dir, 'a.zip');
    const writer = await ZipFileWriter.create(path);
    expect(await writer.addEntry('customers.csv', chunks('"code"\r\n', '"c1"\r\n', ''))).toBe(14);
    await writer.addEntry('empty.csv', []);
    await writer.addEntry('README.md', [Buffer.from('# Export — خان\n')]);
    const size = await writer.close();
    const archive = await readFile(path);
    expect(archive.length).toBe(size);
    expect(
      archive.equals(
        buildZip([
          { name: 'customers.csv', data: '"code"\r\n"c1"\r\n' },
          { name: 'empty.csv', data: '' },
          { name: 'README.md', data: '# Export — خان\n' },
        ])
      )
    ).toBe(true);
    expect(readZip(archive).get('customers.csv')!.toString('utf8')).toBe('"code"\r\n"c1"\r\n');
  });

  it('stops with ZipSizeLimitError once the archive would pass its cap', async () => {
    const writer = await ZipFileWriter.create(join(dir, 'b.zip'), { maxBytes: 200 });
    await writer.addEntry('small.csv', chunks('x'.repeat(50)));
    await expect(
      writer.addEntry('big.csv', chunks('y'.repeat(60), 'z'.repeat(60)))
    ).rejects.toThrow(ZipSizeLimitError);
    expect(writer.bytesWritten).toBeLessThanOrEqual(200);
    await writer.abort();
  });

  it('never overwrites an existing file and refuses unsafe names', async () => {
    const path = join(dir, 'c.zip');
    const writer = await ZipFileWriter.create(path);
    await expect(ZipFileWriter.create(path)).rejects.toThrow();
    await expect(writer.addEntry('../evil.csv', [])).rejects.toThrow(/Unsafe/);
    await writer.addEntry('a.csv', []);
    await expect(writer.addEntry('a.csv', [])).rejects.toThrow(/Duplicate/);
    await writer.abort();
  });
});
