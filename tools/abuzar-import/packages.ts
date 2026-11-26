import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { columns, tableNames, type Prepared, type Tables, type Table } from './prepared';

const budget = 4 * 1024 * 1024 - 128 * 1024;
function encodeTable<K extends Table>(name: K, rows: Tables[K]) {
  const header: readonly string[] = columns[name];
  const lines = rows.map((row) =>
    header
      .map((key) => {
        const cell = (row as Record<string, string>)[key]!;
        return /[",\r\n]/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell;
      })
      .join(',')
  );
  return [header.join(','), ...lines, ''].join('\n');
}
const emptyTables = (): Tables => ({
  products: [],
  parties: [],
  stock: [],
  balances: [],
  history: [],
});
async function writePart(parent: string, name: string, source: Prepared, tables: Tables) {
  const files = tableNames.map((key) => ({
    key,
    bytes: Buffer.from(encodeTable(key, tables[key])),
  }));
  const manifest = {
    version: source.manifest.version,
    sourceFingerprint: source.manifest.sourceFingerprint,
    tables: Object.fromEntries(
      files.map(({ key, bytes }) => [
        key,
        { rows: tables[key].length, sha256: createHash('sha256').update(bytes).digest('hex') },
      ])
    ),
  };
  if (files.reduce((sum, file) => sum + gzipSync(file.bytes).length, 0) > budget) return false;
  const folder = join(parent, name);
  await mkdir(folder, { mode: 0o700 });
  for (const file of files)
    await writeFile(join(folder, file.key + '.csv'), file.bytes, { mode: 0o600, flag: 'wx' });
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest), {
    mode: 0o600,
    flag: 'wx',
  });
  return true;
}

/** Preserve full contact duplicate detection and financial totals in one operational package.
 * History is independent of operational posting and keyed by its original source row id. */
export async function packageForUpload(source: Prepared, parent: string, rowsPerPart = 20000) {
  if (!Number.isSafeInteger(rowsPerPart) || rowsPerPart < 1)
    throw new Error('Invalid history package size.');
  const directory = await mkdtemp(join(parent, 'abuzar-upload-'));
  if (!(await writePart(directory, 'opening', source, { ...source.tables, history: [] })))
    throw new Error(
      'Operational tables exceed the compressed upload limit. Keep the original export and review the package on this computer.'
    );
  const historyPackages: string[] = [];
  let offset = 0;
  while (offset < source.tables.history.length) {
    const name = 'history-' + String(historyPackages.length + 1).padStart(4, '0');
    let count = Math.min(rowsPerPart, source.tables.history.length - offset);
    while (
      !(await writePart(directory, name, source, {
        ...emptyTables(),
        history: source.tables.history.slice(offset, offset + count),
      }))
    ) {
      if (count === 1) throw new Error('A history row exceeds the upload limit.');
      count = Math.floor(count / 2);
    }
    offset += count;
    historyPackages.push(name);
  }
  const result = { directory, historyPackages };
  await writeFile(
    join(directory, 'index.json'),
    JSON.stringify(
      {
        sourceChecksum: source.checksum,
        originalTables: source.manifest.tables,
        openingPackage: 'opening',
        historyPackages,
      },
      null,
      2
    ),
    { flag: 'wx', mode: 0o600 }
  );
  return result;
}
