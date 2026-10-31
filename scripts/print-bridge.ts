#!/usr/bin/env -S npx tsx

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BridgeError,
  resolveTransport,
  type Transport,
} from '../src/lib/restaurant/printing/target';
export { resolveTransport };

const TRANSPORT_TIMEOUT_MS = 5_000;
const QUEUE_TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_048_576;

const TOKEN_FILE_LIMIT = 1024;
const FILE_TOKEN = /^rdk_[A-Za-z0-9_-]{1,512}$/;

function requirePosixTokenFiles() {
  if (
    process.platform === 'win32' ||
    typeof process.geteuid !== 'function' ||
    typeof constants.O_NOFOLLOW !== 'number'
  ) {
    throw new BridgeError(
      'Token files require POSIX owner-only permissions. Use PRINT_BRIDGE_TOKEN on this platform.'
    );
  }
}

export async function readPrintBridgeToken(path: string): Promise<string> {
  requirePosixTokenFiles();
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.uid !== process.geteuid!() ||
        (before.mode & 0o077) !== 0 ||
        before.size > TOKEN_FILE_LIMIT
      ) {
        throw new BridgeError(
          'Token file must be a small regular file owned by this user with owner-only permissions.'
        );
      }
      const bytes = Buffer.alloc(TOKEN_FILE_LIMIT + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat();
      if (
        length > TOKEN_FILE_LIMIT ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new BridgeError('Token file changed or exceeded the size limit.');
      }
      const token = bytes.subarray(0, length).toString('utf8').trim();
      if (!FILE_TOKEN.test(token))
        throw new BridgeError('Token file does not contain a valid device token.');
      return token;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw Object.assign(new BridgeError('Could not securely read PRINT_BRIDGE_TOKEN_FILE.'), {
      code: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ENOENT' : undefined,
    });
  }
}

export async function persistPrintBridgeToken(path: string, token: string): Promise<void> {
  requirePosixTokenFiles();
  if (token !== token.trim() || !FILE_TOKEN.test(token))
    throw new BridgeError('Invalid device token.');
  try {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw Object.assign(new BridgeError('Token file already exists; nothing was replaced.'), {
        code: 'EEXIST',
      });
    }
    throw new BridgeError('Could not securely persist the device token.');
  }
}

/** Reserve the owner-only destination before exchanging a one-use code. */
export async function enrollPrintBridge(input: {
  baseUrl: string;
  code: string;
  tokenFile: string;
  signal?: AbortSignal;
}): Promise<string> {
  requirePosixTokenFiles();
  if (
    !isAbsolute(input.tokenFile) ||
    input.code.length !== 36 ||
    !/^pbe_[A-Za-z0-9_-]{32}$/.test(input.code)
  )
    throw new BridgeError('Enrollment requires an exact code and an absolute new token-file path.');
  const endpoint = bridgeEndpoint(input.baseUrl);
  endpoint.pathname += '/enroll';
  let handle;
  try {
    handle = await open(
      input.tokenFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch {
    throw new BridgeError(
      'Could not reserve a new owner-only token file. No enrollment was attempted.'
    );
  }
  try {
    const reserved = await handle.stat();
    const verifyReservation = async () => {
      const current = await lstat(input.tokenFile);
      if (
        !reserved.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== reserved.dev ||
        current.ino !== reserved.ino ||
        current.uid !== process.geteuid!() ||
        (current.mode & 0o777) !== 0o600
      )
        throw new Error('Token reservation changed.');
    };
    await verifyReservation();
    // Persist the reservation before sending the one-use exchange. Never unlink on failure.
    await handle.sync();
    const directory = await open(
      dirname(input.tokenFile),
      constants.O_RDONLY | constants.O_DIRECTORY
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: input.code }),
      redirect: 'error',
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) throw new Error('Enrollment refused.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > TOKEN_FILE_LIMIT) {
          await reader.cancel();
          throw new Error('Invalid enrollment response.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !body ||
      typeof body !== 'object' ||
      !('token' in body) ||
      typeof body.token !== 'string' ||
      !FILE_TOKEN.test(body.token) ||
      body.token !== body.token.trim() ||
      !('deviceId' in body) ||
      typeof body.deviceId !== 'string' ||
      !body.deviceId
    )
      throw new Error('Invalid enrollment response.');
    await verifyReservation();
    await handle.writeFile(`${body.token}\n`, 'utf8');
    await handle.sync();
    await verifyReservation();
    return body.token;
  } catch {
    throw new BridgeError(
      'Enrollment could not be confirmed. Keep the reserved token file and contact your administrator before recovery; do not retry the code.'
    );
  } finally {
    await handle.close();
  }
}

export async function resolvePrintBridgeToken(input: {
  token?: string;
  tokenFile?: string;
  enrollmentCode?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (input.token) return input.token;
  if (input.tokenFile) {
    try {
      return await readPrintBridgeToken(input.tokenFile);
    } catch (error) {
      if (!input.enrollmentCode || (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
  if (input.enrollmentCode)
    return enrollPrintBridge({
      baseUrl: input.baseUrl ?? '',
      code: input.enrollmentCode,
      tokenFile: input.tokenFile ?? '',
      signal: input.signal,
    });
  return '';
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
export function queueCommand(target: Extract<Transport, { kind: 'queue' }>): {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
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
      env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' },
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
      NODE_ENV: 'production',
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PATH: win32.join(systemRoot, 'System32'),
      DEVFATHOM_PRINT_QUEUE: target.queue,
    },
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
        token: await resolvePrintBridgeToken({
          token: process.env.PRINT_BRIDGE_TOKEN,
          tokenFile: process.env.PRINT_BRIDGE_TOKEN_FILE,
          enrollmentCode: process.env.PRINT_BRIDGE_ENROLLMENT_CODE,
          baseUrl: process.env.PRINT_BRIDGE_BASE_URL,
          signal: controller.signal,
        }),
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
