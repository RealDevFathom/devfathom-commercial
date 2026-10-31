// @vitest-environment node

import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  persistPrintBridgeToken,
  readPrintBridgeToken,
  resolvePrintBridgeToken,
} from '../scripts/print-bridge';

let scratch: string;
const syntheticToken = 'rdk_synthetic_local_test_only';

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'print-bridge-token-'));
});
afterEach(async () => {
  // Only this test's private synthetic fixtures; never an operator token path.
  await rm(scratch, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('print bridge token files', () => {
  it('persists exclusively with owner-only permissions and reads the same token', async () => {
    const path = join(scratch, 'token');
    await persistPrintBridgeToken(path, syntheticToken);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe(`${syntheticToken}\n`);
    await expect(readPrintBridgeToken(path)).resolves.toBe(syntheticToken);
  });
  it('refuses replacement of an existing token', async () => {
    const path = join(scratch, 'token');
    await persistPrintBridgeToken(path, syntheticToken);
    await expect(persistPrintBridgeToken(path, 'rdk_another_synthetic')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(path, 'utf8')).toBe(`${syntheticToken}\n`);
  });
  it('refuses tokens readable by other users', async () => {
    const path = join(scratch, 'token');
    await persistPrintBridgeToken(path, syntheticToken);
    await chmod(path, 0o644);
    await expect(readPrintBridgeToken(path)).rejects.toThrow('owner-only permissions');
  });
  it('refuses symlinks for reads and exclusive persistence', async () => {
    const target = join(scratch, 'target');
    const path = join(scratch, 'token');
    await persistPrintBridgeToken(target, syntheticToken);
    await symlink(target, path);
    await expect(readPrintBridgeToken(path)).rejects.toThrow('Could not securely read');
    await expect(persistPrintBridgeToken(path, 'rdk_another_synthetic')).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(`${syntheticToken}\n`);
  });
  it('refuses directories', async () => {
    const path = join(scratch, 'directory');
    await mkdir(path, { mode: 0o700 });
    await expect(readPrintBridgeToken(path)).rejects.toThrow();
  });
  it.each(['rdk_' + 'x'.repeat(1024), 'not_a_device_token', 'rdk_first\nrdk_second'])(
    'refuses malformed or oversized file contents #%#',
    async (contents) => {
      const path = join(scratch, 'token');
      await writeFile(path, contents, { mode: 0o600 });
      await expect(readPrintBridgeToken(path)).rejects.toThrow();
    }
  );
  it('fails closed for a missing selected file without including the path', async () => {
    const path = join(scratch, 'synthetic-private-name');
    await expect(resolvePrintBridgeToken({ tokenFile: path })).rejects.toThrow(
      'Could not securely read PRINT_BRIDGE_TOKEN_FILE.'
    );
    await expect(readPrintBridgeToken(path)).rejects.not.toThrow(path);
  });
  it('loads a selected file when no injected token is present', async () => {
    const path = join(scratch, 'token');
    await persistPrintBridgeToken(path, syntheticToken);
    await expect(resolvePrintBridgeToken({ tokenFile: path })).resolves.toBe(syntheticToken);
  });
  it.each(['invalid', 'rdk_synthetic\n'])(
    'rejects invalid persistence input before creating a file #%#',
    async (token) => {
      const path = join(scratch, 'token');
      await expect(persistPrintBridgeToken(path, token)).rejects.toThrow('Invalid device token');
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
});

describe('print bridge token selection', () => {
  it('preserves injected token precedence without inspecting a selected file', async () => {
    await expect(
      resolvePrintBridgeToken({
        token: 'existing-injected-value',
        tokenFile: join(scratch, 'missing'),
      })
    ).resolves.toBe('existing-injected-value');
  });
  it('leaves missing configuration for the existing bridge validation', async () => {
    await expect(resolvePrintBridgeToken({})).resolves.toBe('');
  });
});
