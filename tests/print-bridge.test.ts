// @vitest-environment node

import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dryRun,
  printerAllowlist,
  queueCommand,
  reserveAttempt,
  resolveTransport,
  runPrintBridge,
  bridgeVertical,
  writeToPrinter,
} from '../scripts/print-bridge';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  return { ...actual, connect: vi.fn(actual.connect) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const receipt = Buffer.from([0x1b, 0x40, 0x41, 0x0a, 0x00, 0xff]);
const queueId = 'queue:///Receipt_Printer';
const claimToken = 'ab'.repeat(32);
const hostProcess = process;
let stateDir: string;

beforeEach(async () => {
  const scratch =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  stateDir = await mkdtemp(join(scratch, 'print-bridge-test-'));
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  // Clear unconsumed child fixtures even when validation failed before spawn.
  vi.mocked(spawn).mockReset();
  await rm(stateDir, { recursive: true, force: true });
  expect(process).toBe(hostProcess);
});

function fakeChild(code: number | null = 0, error?: Error) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: vi.fn() });
  const chunks: Buffer[] = [];
  child.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  child.stdin.once('finish', () =>
    queueMicrotask(() => {
      if (error) child.emit('error', error);
      else if (code !== null) child.emit('close', code);
    })
  );
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return { child, chunks };
}

function input() {
  return {
    baseUrl: 'https://print.example',
    token: 'secret-never-log',
    allowedPrinterIds: [queueId],
    stateDir,
  };
}

function claimed(overrides = {}) {
  return new Response(
    JSON.stringify({
      job: {
        id: 'job-1',
        printerId: queueId,
        bytes: receipt.toString('base64'),
        claimToken,
        ...overrides,
      },
    })
  );
}

describe('explicit transport configuration', () => {
  it('resolves default TCP9100 and IPv6', () => {
    expect(resolveTransport('tcp://printer.local')).toEqual({
      kind: 'tcp',
      host: 'printer.local',
      port: 9100,
    });
    expect(resolveTransport('tcp://[::1]:9200')).toEqual({ kind: 'tcp', host: '::1', port: 9200 });
  });

  it.each([
    '/dev/usb/lp0',
    'usb:///dev/usb/lp0',
    'serial:///dev/ttyUSB0',
    'file:///dev/cu.usbserial',
  ])('retains POSIX target %s', (id) => {
    expect(resolveTransport(id, 'darwin').kind).toBe('device');
  });

  it('decodes installed Windows queue names without treating punctuation as code', () => {
    const name = 'Receipt $(whoami); "front"';
    expect(resolveTransport(`queue:///${encodeURIComponent(name)}`, 'win32')).toEqual({
      kind: 'queue',
      queue: name,
      platform: 'win32',
    });
  });

  it.each([
    '',
    'tcp://user:secret@host',
    'tcp://host:0',
    'tcp://host:65536',
    'tcp://host/path',
    'tcp://host?x=1',
    'queue://remote/name',
    'queue:///',
    'queue:///%5C%5Cserver%5Cqueue',
    'queue:///%0a',
    'queue:///%ZZ',
    '/etc/passwd',
    'file:///home/operator/receipt',
    'serial:///dev/%2e%2e/etc/passwd',
  ])('rejects unsafe or ambiguous target %s', (id) => {
    expect(() => resolveTransport(id, 'darwin')).toThrow();
  });

  it('rejects unsupported OS queue and direct Windows serial', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(() => resolveTransport(queueId, 'linux')).toThrow('requires Windows or macOS');
    expect(() => printerAllowlist(JSON.stringify([queueId]))).toThrow('requires Windows or macOS');
    expect(() => resolveTransport('serial:///dev/COM1', 'win32')).toThrow(
      'installed queue on Windows'
    );
    expect(() => resolveTransport('queue:///-d%20other', 'darwin')).toThrow('CUPS destination');
  });

  it.each([undefined, 'bad-json', '[]', '[1]', JSON.stringify(Array(101).fill(queueId))])(
    'rejects invalid allowlist %#',
    (value) => {
      expect(() => printerAllowlist(value)).toThrow();
    }
  );

  it('dry-run returns a synthetic diagnostic without any device/network/command I/O', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const result = dryRun(queueId, printerAllowlist(JSON.stringify([queueId])));
    expect(result).toMatchObject({
      dryRun: true,
      transport: { kind: 'queue', queue: 'Receipt_Printer' },
      physicalOutputVerified: false,
    });
    expect(result.byteCount).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(spawn).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(() => dryRun(queueId, [])).toThrow('allowlist');
  });
});

describe('native queue dispatch', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
  });

  it('pipes exact bytes to local CUPS with fixed arguments and no inherited secrets', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PRINT_BRIDGE_TOKEN', 'sensitive');
    vi.stubEnv('CUPS_SERVER', 'untrusted.example');
    const { chunks } = fakeChild();
    await writeToPrinter(queueId, receipt, [queueId]);
    expect(Buffer.concat(chunks)).toEqual(receipt);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/lp',
      [
        '-h',
        'localhost',
        '-d',
        'Receipt_Printer',
        '-n',
        '1',
        '-o',
        'raw',
        '-o',
        'job-sheets=none',
        '-t',
        'DevFathom receipt',
        '--',
        '-',
      ],
      {
        shell: false,
        windowsHide: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' },
        stdio: ['pipe', 'ignore', 'ignore'],
      }
    );
  });

  it('Windows command keeps queue data out of PowerShell code/arguments and preserves policy', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PRINT_BRIDGE_TOKEN', 'sensitive');
    vi.stubEnv('NODE_OPTIONS', '--inspect');
    const queue = 'Receipt $(whoami); "front"';
    const command = queueCommand({ kind: 'queue', queue, platform: 'win32' });
    expect(command.file).toMatch(/System32\\WindowsPowerShell\\v1.0\\powershell.exe$/);
    expect(command.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-File']);
    expect(command.args.at(-1)).toMatch(/print-bridge-windows.ps1$/);
    expect(command.args.join(' ')).not.toContain(queue);
    expect(command.args.join(' ')).not.toMatch(/Bypass|ExecutionPolicy|-Command/);
    expect(command.env.DEVFATHOM_PRINT_QUEUE).toBe(queue);
    expect(command.env.NODE_ENV).toBe('production');
    expect(command.env.PRINT_BRIDGE_TOKEN).toBeUndefined();
    expect(command.env.NODE_OPTIONS).toBeUndefined();
  });

  it('Windows submission pipes binary-safe base64 only to the fixed helper', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { child, chunks } = fakeChild();
    const id = 'queue:///Receipt%20Printer';
    await writeToPrinter(id, receipt, [id]);
    expect(spawn).toHaveReturnedWith(child);
    expect(Buffer.concat(chunks).toString()).toBe(receipt.toString('base64'));
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({
      shell: false,
      env: { DEVFATHOM_PRINT_QUEUE: 'Receipt Printer' },
    });
  });

  it.each([1, 2])('nonzero native exit %s fails once without retry', async (code) => {
    fakeChild(code);
    await expect(writeToPrinter(queueId, receipt, [queueId])).rejects.toThrow(
      'delivery may be partial'
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('missing command/permission errors are useful and redact native secret text', async () => {
    fakeChild(0, new Error('EACCES secret-never-log'));
    await expect(writeToPrinter(queueId, receipt, [queueId])).rejects.toThrow('permissions');
  });

  it('times out and terminates one native submission', async () => {
    vi.useFakeTimers();
    const { child } = fakeChild(null);
    const result = expect(writeToPrinter(queueId, receipt, [queueId])).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('handles a disconnected stdin without an unhandled error or retry', async () => {
    const { child } = fakeChild(null);
    const result = expect(writeToPrinter(queueId, receipt, [queueId])).rejects.toThrow(
      'Queue submission failed'
    );
    child.stdin.emit('error', new Error('EPIPE sensitive'));
    await result;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('fails closed before spawn for denied targets and oversized receipts', async () => {
    await expect(writeToPrinter(queueId, receipt, [])).rejects.toThrow('allowlist');
    await expect(writeToPrinter(queueId, Buffer.alloc(1_048_577), [queueId])).rejects.toThrow(
      '1048576'
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('TCP and POSIX device writes', () => {
  it('sends exact receipt bytes to an isolated fake TCP printer', async () => {
    const chunks: Buffer[] = [];
    let received!: () => void;
    const ended = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = createServer((socket) => {
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', received);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fake TCP address');
      const id = `tcp://127.0.0.1:${address.port}`;
      await writeToPrinter(id, receipt, [id]);
      await ended;
      expect(Buffer.concat(chunks)).toEqual(receipt);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('handles TCP refusal without replay', async () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
    vi.mocked(connect).mockReturnValueOnce(socket as unknown as ReturnType<typeof connect>);
    const id = 'tcp://fake-printer:9100';
    const result = expect(writeToPrinter(id, receipt, [id])).rejects.toThrow('TCP write failed');
    socket.emit('error', new Error('ECONNREFUSED'));
    await result;
    expect(socket.end).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('fails promptly on TCP close before the write callback', async () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
    vi.mocked(connect).mockReturnValueOnce(socket as unknown as ReturnType<typeof connect>);
    const id = 'tcp://fake-printer:9100';
    const result = expect(writeToPrinter(id, receipt, [id])).rejects.toThrow(
      'TCP connection closed'
    );
    socket.emit('connect');
    socket.emit('close');
    await result;
    expect(socket.end).toHaveBeenCalledTimes(1);
  });

  it('bounds stalled TCP connections and never resends', async () => {
    vi.useFakeTimers();
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn((error) => socket.emit('error', error)),
      end: vi.fn(),
    });
    vi.mocked(connect).mockReturnValueOnce(socket as unknown as ReturnType<typeof connect>);
    const id = 'tcp://fake-printer:9100';
    const result = expect(writeToPrinter(id, receipt, [id])).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(socket.end).not.toHaveBeenCalled();
  });

  it('retains serial byte writes and handles partial writes without resending a prefix', async () => {
    const write = vi
      .fn()
      .mockResolvedValueOnce({ bytesWritten: 2 })
      .mockResolvedValueOnce({ bytesWritten: receipt.length - 2 });
    const close = vi.fn();
    vi.mocked(open).mockResolvedValueOnce({
      stat: async () => ({ isCharacterDevice: () => true }),
      write,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    const id = 'serial:///dev/cu.fake';
    await writeToPrinter(id, receipt, [id]);
    expect(open).toHaveBeenCalledWith(
      '/dev/cu.fake',
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    expect(write.mock.calls.map((call) => call[1])).toEqual([0, 2]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects ordinary files before writing', async () => {
    const write = vi.fn();
    const close = vi.fn();
    vi.mocked(open).mockResolvedValueOnce({
      stat: async () => ({ isCharacterDevice: () => false }),
      write,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    await expect(writeToPrinter('/dev/fake', receipt, ['/dev/fake'])).rejects.toThrow(
      'character-device'
    );
    expect(write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not retry a serial disconnect/permission failure', async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error('EACCES /secret'));
    await expect(writeToPrinter('/dev/fake', receipt, ['/dev/fake'])).rejects.toThrow(
      'permissions'
    );
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('durable duplicate prevention and server contract', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
  });

  it('persists before dispatch, acknowledges existing status, and sends no receipt data in ack', async () => {
    const controller = new AbortController();
    vi.mocked(fetch)
      .mockResolvedValueOnce(claimed())
      .mockImplementationOnce(async () => {
        controller.abort();
        return new Response('{}');
      });
    fakeChild();
    await runPrintBridge({ ...input(), signal: controller.signal });
    expect(await readdir(stateDir)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1][1]).toMatchObject({
      redirect: 'error',
      body: JSON.stringify({ jobId: 'job-1', claimToken, status: 'PRINTED' }),
      headers: { Authorization: `Bearer ${input().token}` },
    });
  });

  it('lost acknowledgement stops; restart with same journal never prints again', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(claimed())
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    fakeChild();
    await expect(runPrintBridge(input())).rejects.toThrow('Acknowledgement failed');
    vi.mocked(fetch).mockResolvedValueOnce(claimed());
    await expect(runPrintBridge(input())).rejects.toThrow('Attempt marker exists');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('ambiguous transport failure retains marker and never reports OFFLINE/retries', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(claimed());
    fakeChild(1);
    await expect(runPrintBridge(input())).rejects.toThrow('delivery may be partial');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockResolvedValueOnce(claimed());
    await expect(runPrintBridge(input())).rejects.toThrow('Attempt marker exists');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('simultaneous reservations allow one dispatch candidate', async () => {
    const results = await Promise.allSettled([
      reserveAttempt(stateDir, input().baseUrl, 'same'),
      reserveAttempt(stateDir, input().baseUrl, 'same'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('journal permission failure prevents dispatch', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(claimed());
    vi.mocked(open).mockRejectedValueOnce(new Error('EACCES sensitive-path'));
    await expect(runPrintBridge(input())).rejects.toThrow('cannot be persisted');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { bytes: 'not base64' },
    { printerId: 'tcp://unapproved:9100' },
    { id: 3 },
    { bytes: '' },
  ])('rejects invalid/unapproved claimed job %# before dispatch', async (job) => {
    vi.mocked(fetch).mockResolvedValueOnce(claimed(job));
    await expect(runPrintBridge(input())).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(await readdir(stateDir)).toHaveLength(0);
  });

  it.each([undefined, '', 'secret-invalid-token', 'AB'.repeat(32), 'a'.repeat(63)])(
    'rejects missing/malformed claim token %# without dispatch or leaking it',
    async (claimToken) => {
      vi.mocked(fetch).mockResolvedValueOnce(claimed({ claimToken }));
      await expect(runPrintBridge(input())).rejects.toThrow(
        'Missing or invalid claim token. Deploy the matching queue-security API before starting this bridge.'
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await readdir(stateDir)).toHaveLength(0);
    }
  );

  it.each(['http://print.example', 'https://user:password@print.example'])(
    'rejects unsafe bridge URL %s before sending bearer',
    async (baseUrl) => {
      await expect(runPrintBridge({ ...input(), baseUrl })).rejects.toThrow(
        'HTTPS without credentials'
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('empty poll preserves cancellation and makes no transport call', async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      controller.abort();
      return new Response(null, { status: 204 });
    });
    await runPrintBridge({ ...input(), signal: controller.signal });
    expect(spawn).not.toHaveBeenCalled();
    expect(await readdir(stateDir)).toHaveLength(0);
  });
});

describe('DEV-741 pharmacy bridge mode', () => {
  const pharmacyToken = `ppb_${'A'.repeat(43)}.${Buffer.from('org_pharmacy').toString('base64url')}`;

  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
  });

  function pharmacyInput() {
    return { ...input(), token: pharmacyToken };
  }

  it('selects the queue from the credential and keeps every other token on Restaurant', () => {
    expect(bridgeVertical(pharmacyToken)).toBe('pharmacy');
    expect(bridgeVertical('rdk_abc')).toBe('restaurant');
    expect(bridgeVertical('secret-never-log')).toBe('restaurant');
    expect(() => bridgeVertical('ppb_short.x')).toThrow('Malformed Pharmacy');
  });

  it('claims from the pharmacy endpoint and acknowledges TRANSPORT_ACCEPTED, never PRINTED', async () => {
    const controller = new AbortController();
    vi.mocked(fetch)
      .mockResolvedValueOnce(claimed({ attempt: 1 }))
      .mockImplementationOnce(async () => {
        controller.abort();
        return new Response('{}');
      });
    fakeChild();
    await runPrintBridge({ ...pharmacyInput(), signal: controller.signal });
    const [claimUrl] = vi.mocked(fetch).mock.calls[0];
    expect(String(claimUrl)).toBe('https://print.example/api/pharmacy/print-bridge?wait=20');
    const [ackUrl, ack] = vi.mocked(fetch).mock.calls[1];
    expect(String(ackUrl)).toBe('https://print.example/api/pharmacy/print-bridge');
    expect(ack).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ jobId: 'job-1', claimToken, status: 'TRANSPORT_ACCEPTED' }),
    });
    expect(String(ack?.body)).not.toContain(receipt.toString('base64'));
  });

  it('reports a transport failure once, keeps the marker, and never retries the same attempt', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(claimed({ attempt: 1 }))
      .mockResolvedValueOnce(new Response('{}'));
    fakeChild(1);
    await expect(runPrintBridge(pharmacyInput())).rejects.toThrow('delivery may be partial');
    expect(vi.mocked(fetch).mock.calls[1][1]).toMatchObject({
      body: JSON.stringify({
        jobId: 'job-1',
        claimToken,
        status: 'FAILED',
        failureCode: 'TRANSPORT_FAILED',
      }),
    });
    vi.mocked(fetch).mockResolvedValueOnce(claimed({ attempt: 1 }));
    await expect(runPrintBridge(pharmacyInput())).rejects.toThrow('Attempt marker exists');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('an operator retry is a new attempt with its own marker', async () => {
    const first = new AbortController();
    vi.mocked(fetch)
      .mockResolvedValueOnce(claimed({ attempt: 1 }))
      .mockImplementationOnce(async () => {
        first.abort();
        return new Response('{}');
      });
    fakeChild();
    await runPrintBridge({ ...pharmacyInput(), signal: first.signal });
    const second = new AbortController();
    vi.mocked(fetch)
      .mockResolvedValueOnce(claimed({ attempt: 2 }))
      .mockImplementationOnce(async () => {
        second.abort();
        return new Response('{}');
      });
    fakeChild();
    await runPrintBridge({ ...pharmacyInput(), signal: second.signal });
    expect(await readdir(stateDir)).toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('refuses a missing attempt and reports a non-allowlisted printer without dispatch', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(claimed());
    await expect(runPrintBridge(pharmacyInput())).rejects.toThrow('Invalid claimed attempt');
    vi.mocked(fetch)
      .mockResolvedValueOnce(claimed({ attempt: 1, printerId: 'tcp://10.0.0.9:9100' }))
      .mockResolvedValueOnce(new Response('{}'));
    await expect(runPrintBridge(pharmacyInput())).rejects.toThrow('not in the host allowlist');
    expect(vi.mocked(fetch).mock.calls[2][1]).toMatchObject({
      body: expect.stringContaining('"failureCode":"PRINTER_NOT_ALLOWED"'),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(await readdir(stateDir)).toHaveLength(0);
  });
});
