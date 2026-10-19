import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { persistPrintBridgeToken, readPrintBridgeToken } from '../scripts/print-bridge';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('print bridge token file', () => {
  it('persists the token exclusively with mode 0600 and reads it back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'print-bridge-token-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'token');

    await persistPrintBridgeToken(path, 'rdk_secret');

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(readFile(path, 'utf8')).resolves.toBe('rdk_secret\n');
    await expect(readPrintBridgeToken(path)).resolves.toBe('rdk_secret');
    await expect(persistPrintBridgeToken(path, 'rdk_replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(readFile(path, 'utf8')).resolves.toBe('rdk_secret\n');
  });

  it('rejects a token file accessible by group or other users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'print-bridge-token-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'token');
    await writeFile(path, 'rdk_secret\n', { mode: 0o644 });

    await expect(readPrintBridgeToken(path)).rejects.toThrow(/mode 0600/);
  });
});
