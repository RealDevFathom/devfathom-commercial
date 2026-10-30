// @vitest-environment node
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enrollPrintBridge,
  persistPrintBridgeToken,
  resolvePrintBridgeToken,
} from '../scripts/print-bridge';
const faults = vi.hoisted(() => ({
  destination: '',
  write: false,
  sync: false,
  ownerUnreadable: false,
}));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === faults.destination) {
        if (faults.ownerUnreadable) await handle.chmod(0o200);
        const write = handle.writeFile.bind(handle);
        const sync = handle.sync.bind(handle);
        let syncCalls = 0;
        handle.writeFile = async (...params: Parameters<typeof handle.writeFile>) => {
          if (faults.write) throw new Error('synthetic write failure');
          return write(...params);
        };
        handle.sync = async () => {
          syncCalls += 1;
          if (faults.sync && syncCalls === 2) throw new Error('synthetic fsync failure');
          return sync();
        };
      }
      return handle;
    },
  };
});
let scratch: string;
const code = `pbe_${'A'.repeat(32)}`;
const token = 'rdk_synthetic_enrollment_only';
const request = vi.fn();
const response = () =>
  new Response(JSON.stringify({ token, deviceId: 'synthetic-bridge' }), {
    headers: { 'Content-Type': 'application/json' },
  });
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'print-bridge-enrollment-'));
  faults.destination = '';
  faults.write = false;
  faults.sync = false;
  faults.ownerUnreadable = false;
  request.mockReset().mockResolvedValue(response());
  vi.stubGlobal('fetch', request);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(scratch, { recursive: true, force: true });
});
const input = () => ({
  baseUrl: 'https://example.test/path',
  code,
  tokenFile: join(scratch, 'token'),
});
describe.skipIf(process.platform === 'win32')('offline bridge enrollment (mock HTTPS)', () => {
  it('reserves mode0600 before exchange, persists the token and reuses it without reenrolling', async () => {
    const selected = input();
    request.mockImplementation(async (url, options) => {
      const reserved = await lstat(selected.tokenFile);
      expect(reserved.isFile()).toBe(true);
      expect(reserved.mode & 0o777).toBe(0o600);
      expect(reserved.size).toBe(0);
      expect(String(url)).toBe('https://example.test/api/restaurant/print-bridge/enroll');
      expect(options).toMatchObject({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({ code }),
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return response();
    });
    await expect(enrollPrintBridge(selected)).resolves.toBe(token);
    expect(await readFile(selected.tokenFile, 'utf8')).toBe(`${token}\n`);
    await expect(resolvePrintBridgeToken({ ...selected, enrollmentCode: code })).resolves.toBe(
      token
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it('preserves injected token and existing file precedence even with an enrollment code', async () => {
    await expect(
      resolvePrintBridgeToken({
        token: 'injected',
        tokenFile: input().tokenFile,
        enrollmentCode: code,
      })
    ).resolves.toBe('injected');
    await persistPrintBridgeToken(input().tokenFile, token);
    await expect(
      resolvePrintBridgeToken({ tokenFile: input().tokenFile, enrollmentCode: code })
    ).resolves.toBe(token);
    expect(request).not.toHaveBeenCalled();
  });
  it('enrolls only when the chosen file is missing', async () => {
    await expect(
      resolvePrintBridgeToken({
        baseUrl: input().baseUrl,
        tokenFile: input().tokenFile,
        enrollmentCode: code,
      })
    ).resolves.toBe(token);
    expect(request).toHaveBeenCalledOnce();
  });
  it.each(['empty', 'public', 'symlink'])(
    'refuses %s existing file before exchange',
    async (kind) => {
      const path = input().tokenFile;
      if (kind === 'symlink') {
        await writeFile(join(scratch, 'target'), token, { mode: 0o600 });
        await symlink(join(scratch, 'target'), path);
      } else {
        await writeFile(path, kind === 'empty' ? '' : token, { mode: 0o600 });
        if (kind === 'public') await chmod(path, 0o644);
      }
      await expect(
        resolvePrintBridgeToken({ tokenFile: path, enrollmentCode: code, baseUrl: input().baseUrl })
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    }
  );
  it.each([
    'http://example.test',
    'https://user:pass@example.test',
    'https://example.test?q=x',
    'https://example.test/#fragment',
  ])('rejects unsafe origin %s before file creation', async (baseUrl) => {
    await expect(enrollPrintBridge({ ...input(), baseUrl })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(stat(input().tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['short', `${code}\n`, `pbe_${'A'.repeat(33)}`])(
    'rejects malformed enrollment code #%# before file creation',
    async (invalidCode) => {
      await expect(enrollPrintBridge({ ...input(), code: invalidCode })).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
      await expect(stat(input().tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
  it('requires an absolute new destination and never replaces an existing file', async () => {
    await expect(enrollPrintBridge({ ...input(), tokenFile: 'relative-token' })).rejects.toThrow();
    await persistPrintBridgeToken(input().tokenFile, token);
    await expect(enrollPrintBridge(input())).rejects.toThrow('No enrollment was attempted');
    expect(await readFile(input().tokenFile, 'utf8')).toBe(`${token}\n`);
    expect(request).not.toHaveBeenCalled();
  });
  it('retains an empty reservation after an uncertain exchange and refuses automatic reuse', async () => {
    request.mockRejectedValue(new Error(`private ${code} ${token}`));
    await expect(enrollPrintBridge(input())).rejects.toThrow('do not retry');
    expect(await readFile(input().tokenFile, 'utf8')).toBe('');
    await expect(resolvePrintBridgeToken({ ...input(), enrollmentCode: code })).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    try {
      await enrollPrintBridge({ ...input(), tokenFile: join(scratch, 'second') });
    } catch (error) {
      expect(String(error)).not.toContain(code);
      expect(String(error)).not.toContain(token);
    }
  });
  it.each(['invalid-token', 'missing-device', 'too-large', 'refused'])(
    'keeps reservation without credentials for %s response',
    async (kind) => {
      const body =
        kind === 'invalid-token'
          ? { token: 'bad', deviceId: 'device' }
          : kind === 'missing-device'
            ? { token }
            : { token, deviceId: 'x'.repeat(2048) };
      request.mockResolvedValue(
        new Response(JSON.stringify(body), { status: kind === 'refused' ? 410 : 200 })
      );
      await expect(enrollPrintBridge(input())).rejects.toThrow('could not be confirmed');
      expect(await readFile(input().tokenFile, 'utf8')).toBe('');
      expect(request).toHaveBeenCalledOnce();
    }
  );
  it('refuses a replaced destination after exchange without overwriting replacement bytes', async () => {
    request.mockImplementation(async () => {
      await rename(input().tokenFile, join(scratch, 'reservation'));
      await writeFile(input().tokenFile, 'replacement', { mode: 0o600 });
      return response();
    });
    await expect(enrollPrintBridge(input())).rejects.toThrow('could not be confirmed');
    expect(await readFile(input().tokenFile, 'utf8')).toBe('replacement');
    expect(await readFile(join(scratch, 'reservation'), 'utf8')).toBe('');
  });

  it('rejects an owner-unreadable reservation before consuming the code', async () => {
    // A parent default ACL can override umask. Establish the actual mode on the
    // newly opened reservation so this safety check also runs on ACL-backed filesystems.
    faults.destination = input().tokenFile;
    faults.ownerUnreadable = true;
    await expect(enrollPrintBridge(input())).rejects.toThrow('could not be confirmed');
    expect(request).not.toHaveBeenCalled();
    expect((await stat(input().tokenFile)).mode & 0o777).toBe(0o200);
  });
  it.each(['write', 'sync'] as const)(
    'retains the reservation on post-exchange %s failure without retrying',
    async (operation) => {
      faults.destination = input().tokenFile;
      faults[operation] = true;
      await expect(enrollPrintBridge(input())).rejects.toThrow('could not be confirmed');
      expect(request).toHaveBeenCalledOnce();
      expect((await stat(input().tokenFile)).isFile()).toBe(true);
      expect(await readFile(input().tokenFile, 'utf8')).toBe(
        operation === 'write' ? '' : `${token}\n`
      );
    }
  );
});
