#!/usr/bin/env -S npx tsx

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRANSPORT_TIMEOUT_MS = 5_000;
const QUEUE_TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_048_576;

type Transport =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'device'; path: string }
  | { kind: 'queue'; queue: string; platform: 'darwin' | 'win32' };

class BridgeError extends Error {}

/** Parse only explicit targets. No discovery, default printer, or arbitrary file output. */
export function resolveTransport(printerId: string, platform = process.platform): Transport {
  if (!printerId || printerId.length > 128 || /[\x00-\x20\x7f]/.test(printerId)) {
    throw new BridgeError('Printer ID must be 1–128 characters with URL-encoded spaces.');
  }
  let target: URL;
  try {
    target = new URL(printerId.startsWith('/') ? `file://${printerId}` : printerId);
  } catch {
    throw new BridgeError('Use tcp://host:9100, queue:///encoded-name, or a /dev/ path.');
  }
  if (target.username || target.password || target.search || target.hash) {
    throw new BridgeError(
      'Printer IDs cannot contain credentials, query parameters, or fragments.'
    );
  }
  if (target.protocol === 'tcp:') {
    const port = Number(target.port || '9100');
    if (
      !target.hostname ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      !['', '/'].includes(target.pathname)
    ) {
      throw new BridgeError('Invalid TCP printer address.');
    }
    return { kind: 'tcp', host: target.hostname.replace(/^\[|\]$/g, ''), port };
  }
  let path: string;
  try {
    path = decodeURIComponent(target.pathname);
  } catch {
    throw new BridgeError('Invalid percent encoding in printer ID.');
  }
  if (target.host || /[\x00-\x1f\x7f]/.test(path)) {
    throw new BridgeError(
      'Queue and device targets must be local and contain no control characters.'
    );
  }
  if (target.protocol === 'queue:') {
    if (platform !== 'darwin' && platform !== 'win32') {
      throw new BridgeError('Installed queue transport requires Windows or macOS.');
    }
    const queue = path.slice(1);
    if (!path.startsWith('/') || !queue || /[/\\]/.test(queue) || queue.trim() !== queue) {
      throw new BridgeError('Specify one installed local queue name: queue:///encoded-name.');
    }
    if (platform === 'darwin' && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(queue)) {
      throw new BridgeError('Use the macOS CUPS destination name (letters, numbers, _, ., -).');
    }
    return { kind: 'queue', queue, platform };
  }
  if (
    !['file:', 'usb:', 'serial:'].includes(target.protocol) ||
    platform === 'win32' ||
    !path.startsWith('/dev/') ||
    posix.normalize(path) !== path
  ) {
    throw new BridgeError(
      'Direct USB/serial requires a POSIX /dev/ character device; use an installed queue on Windows.'
    );
  }
  return { kind: 'device', path };
}

export function printerAllowlist(value: string | undefined): string[] {
  let ids: unknown;
  try {
    ids = JSON.parse(value ?? 'null');
  } catch {
    throw new BridgeError('PRINT_BRIDGE_PRINTER_IDS must be a JSON array of explicit printer IDs.');
  }
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== 'string')
  ) {
    throw new BridgeError('Allowlist must contain 1–100 printer IDs.');
  }
  ids.forEach((id: string) => resolveTransport(id));
  return ids as string[];
}

/** Fixed native operations only. Child processes never inherit bridge tokens or receipt metadata. */
export function queueCommand(target: Extract<Transport, { kind: 'queue' }>) {
  if (target.platform === 'darwin') {
    return {
      file: '/usr/bin/lp',
      args: [
        '-h',
        'localhost',
        '-d',
        target.queue,
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
      env: { PATH: '/usr/bin:/bin', LANG: 'C' } as NodeJS.ProcessEnv,
    };
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (!/^[A-Za-z]:\\/.test(systemRoot) || systemRoot.includes('..')) {
    throw new BridgeError('Invalid Windows SystemRoot.');
  }
  return {
    file: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fileURLToPath(new URL('./print-bridge-windows.ps1', import.meta.url)),
    ],
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PATH: win32.join(systemRoot, 'System32'),
      DEVFATHOM_PRINT_QUEUE: target.queue,
    } as NodeJS.ProcessEnv,
  };
}

async function writeQueue(target: Extract<Transport, { kind: 'queue' }>, bytes: Uint8Array) {
  const command = queueCommand(target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      shell: false,
      windowsHide: true,
      env: command.env,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const fail = () =>
      reject(
        new BridgeError(
          'Queue submission failed or timed out. Check installed queue, RAW support, permissions and OS policy; delivery may be partial. Do not retry blindly.'
        )
      );
    const timer = setTimeout(() => {
      child.kill();
      fail();
    }, QUEUE_TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      fail();
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else fail();
    });
    child.stdin.once('error', () => {
      child.kill();
      clearTimeout(timer);
      fail();
    });
    child.stdin.end(target.platform === 'win32' ? Buffer.from(bytes).toString('base64') : bytes);
  });
}

/** Transport acceptance only; neither socket flush nor spool acceptance proves paper output. */
export async function writeToPrinter(
  printerId: string,
  bytes: Uint8Array,
  allowedPrinterIds: readonly string[]
): Promise<void> {
  if (!allowedPrinterIds.includes(printerId))
    throw new BridgeError('Printer ID is not in the host allowlist.');
  const target = resolveTransport(printerId);
  if (!bytes.length || bytes.length > MAX_BYTES)
    throw new BridgeError('Receipt must contain 1–1048576 bytes.');
  if (target.kind === 'queue') return writeQueue(target, bytes);
  if (target.kind === 'tcp') {
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: target.host, port: target.port });
      const timer = setTimeout(() => socket.destroy(new Error('timeout')), TRANSPORT_TIMEOUT_MS);
      socket.once('error', () => {
        clearTimeout(timer);
        reject(
          new BridgeError(
            'TCP write failed or timed out; delivery may be partial. Check configured host/port.'
          )
        );
      });
      socket.once('close', () => {
        clearTimeout(timer);
        reject(
          new BridgeError('TCP connection closed; delivery may be partial. Reconcile before retry.')
        );
      });
      socket.once('connect', () =>
        socket.end(bytes, () => {
          clearTimeout(timer);
          socket.destroy();
          resolve();
        })
      );
    });
    return;
  }
  try {
    const handle = await open(
      target.path,
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      if (!(await handle.stat()).isCharacterDevice()) throw new Error('not a character device');
      let offset = 0;
      const deadline = Date.now() + TRANSPORT_TIMEOUT_MS;
      while (offset < bytes.length) {
        if (Date.now() > deadline) throw new Error('timeout');
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw new Error('short write');
        offset += bytesWritten;
      }
    } finally {
      await handle.close();
    }
  } catch {
    throw new BridgeError(
      'Device write failed. Check character-device path, permissions and preconfigured serial settings; delivery may be partial.'
    );
  }
}

function safeError(error: unknown): string {
  return error instanceof BridgeError
    ? error.message
    : 'Bridge operation failed; inspect host configuration and connectivity. No automatic job retry.';
}

function bridgeEndpoint(baseUrl: string, wait?: number): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new BridgeError(
      'PRINT_BRIDGE_BASE_URL must be HTTPS without credentials, query or fragment.'
    );
  }
  const endpoint = new URL('/api/restaurant/print-bridge', base);
  if (wait !== undefined) endpoint.searchParams.set('wait', String(wait));
  return endpoint;
}

/** Exclusive, durable marker is written BEFORE dispatch. Never removed automatically. */
export async function reserveAttempt(
  stateDir: string,
  baseUrl: string,
  jobId: string
): Promise<void> {
  if (!isAbsolute(stateDir) || !jobId || jobId.length > 200)
    throw new BridgeError('Invalid persistent state directory or job ID.');
  const key = createHash('sha256')
    .update(new URL(baseUrl).origin)
    .update('\0')
    .update(jobId)
    .digest('hex');
  try {
    const marker = await open(join(stateDir, `${key}.attempt`), 'wx', 0o600);
    try {
      await marker.writeFile('attempted\n');
      await marker.sync();
    } finally {
      await marker.close();
    }
    // Persist the directory entry on POSIX as well as the marker contents.
    if (process.platform !== 'win32') {
      const directory = await open(stateDir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch {
    throw new BridgeError(
      'Attempt marker exists or cannot be persisted. Stopped before dispatch; reconcile prior delivery and state-directory permissions.'
    );
  }
}

export async function runPrintBridge(input: {
  baseUrl: string;
  token: string;
  allowedPrinterIds: readonly string[];
  stateDir: string;
  signal?: AbortSignal;
}): Promise<void> {
  const claimUrl = bridgeEndpoint(input.baseUrl, 20);
  if (!input.token || !isAbsolute(input.stateDir))
    throw new BridgeError('Set device token and absolute PRINT_BRIDGE_STATE_DIR.');
  printerAllowlist(JSON.stringify(input.allowedPrinterIds));
  await mkdir(input.stateDir, { recursive: true, mode: 0o700 });
  const headers = { Authorization: `Bearer ${input.token}` };
  // Stop on any failure. Server leases can reoffer jobs; the marker prevents replay on this host.
  while (!input.signal?.aborted) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(25_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    const response = await fetch(claimUrl, { headers, signal, redirect: 'error' });
    if (response.status === 204) continue;
    if (!response.ok)
      throw new BridgeError(`Claim failed with HTTP ${response.status}; bridge stopped.`);
    const payload = (await response.json()) as {
      job?: { id?: unknown; printerId?: unknown; bytes?: unknown; claimToken?: unknown };
    };
    const job = payload?.job;
    if (typeof job?.claimToken !== 'string' || !/^[a-f0-9]{64}$/.test(job.claimToken)) {
      throw new BridgeError(
        'Missing or invalid claim token. Deploy the matching queue-security API before starting this bridge.'
      );
    }
    if (
      !job ||
      typeof job.id !== 'string' ||
      typeof job.printerId !== 'string' ||
      typeof job.bytes !== 'string' ||
      !job.bytes.length ||
      job.bytes.length > Math.ceil(MAX_BYTES / 3) * 4
    ) {
      throw new BridgeError('Invalid or oversized claimed job; bridge stopped.');
    }
    const bytes = Buffer.from(job.bytes, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== job.bytes)
      throw new BridgeError('Invalid receipt encoding; bridge stopped.');
    if (!input.allowedPrinterIds.includes(job.printerId))
      throw new BridgeError('Claimed printer is not in the host allowlist; bridge stopped.');
    resolveTransport(job.printerId);
    if (input.signal?.aborted) return;
    await reserveAttempt(input.stateDir, input.baseUrl, job.id);
    await writeToPrinter(job.printerId, bytes, input.allowedPrinterIds);
    // Existing server vocabulary: PRINTED means transport accepted, not physical confirmation.
    const acknowledgement = await fetch(bridgeEndpoint(input.baseUrl), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, claimToken: job.claimToken, status: 'PRINTED' }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!acknowledgement.ok)
      throw new BridgeError(
        `Acknowledgement failed with HTTP ${acknowledgement.status}; transport may have delivered. Reconcile before restart.`
      );
  }
}

export function dryRun(printerId: string, allowedPrinterIds: readonly string[]) {
  if (!allowedPrinterIds.includes(printerId))
    throw new BridgeError('Diagnostic printer is not in the host allowlist.');
  const transport = resolveTransport(printerId);
  // Deliberately synthetic: no application data, renderer changes, or cutter/drawer command.
  const bytes = Buffer.from(
    '\x1b@DEVFATHOM TRANSPORT DIAGNOSTIC\nSYNTHETIC RECEIPT - NOT A SALE\n\n',
    'ascii'
  );
  return {
    dryRun: true,
    transport,
    byteCount: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    nativeCommand: transport.kind === 'queue' ? queueCommand(transport).file : null,
    physicalOutputVerified: false,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void (async () => {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--dry-run') || args.length > 1)
      throw new BridgeError('Usage: restaurant:print-bridge [--dry-run].');
    const allowedPrinterIds = printerAllowlist(process.env.PRINT_BRIDGE_PRINTER_IDS);
    if (args.includes('--dry-run')) {
      console.log(
        JSON.stringify(
          dryRun(process.env.PRINT_BRIDGE_PRINTER_ID ?? '', allowedPrinterIds),
          null,
          2
        )
      );
      return;
    }
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    try {
      await runPrintBridge({
        baseUrl: process.env.PRINT_BRIDGE_BASE_URL ?? '',
        token: process.env.PRINT_BRIDGE_TOKEN ?? '',
        stateDir: process.env.PRINT_BRIDGE_STATE_DIR ?? '',
        allowedPrinterIds,
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })().catch((error) => {
    console.error(`Print bridge stopped: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
