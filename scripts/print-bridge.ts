#!/usr/bin/env -S npx tsx

import { open, readFile, stat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type BridgeJob = { id: string; printerId: string; address: string; bytes: string };

const CONNECT_TIMEOUT_MS = 5_000;

export async function readPrintBridgeToken(path: string): Promise<string> {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      'PRINT_BRIDGE_TOKEN_FILE must be readable and writable only by its owner (mode 0600).'
    );
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (!token.startsWith('rdk_'))
    throw new Error('PRINT_BRIDGE_TOKEN_FILE does not contain a valid device token.');
  return token;
}

export async function persistPrintBridgeToken(path: string, token: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${token}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

function devicePath(printerId: string): string {
  if (printerId.startsWith('/')) return printerId;
  const target = new URL(printerId);
  if (!['file:', 'usb:', 'serial:'].includes(target.protocol) || !target.pathname.startsWith('/')) {
    throw new Error('Printer ID must be tcp://host:port or an absolute device path.');
  }
  return decodeURIComponent(target.pathname);
}

/** Write one ESC/POS payload to a network printer or OS device node. */
export async function writeToPrinter(printerId: string, bytes: Uint8Array): Promise<void> {
  if (printerId.startsWith('tcp://')) {
    const target = new URL(printerId);
    const port = Number.parseInt(target.port || '9100', 10);
    if (!target.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Invalid TCP printer address.');
    }
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: target.hostname, port });
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.once('timeout', () => socket.destroy(new Error('Printer connection timed out.')));
      socket.once('error', reject);
      socket.once('connect', () => socket.end(bytes, resolve));
    });
    return;
  }

  const handle = await open(devicePath(printerId), 'w');
  try {
    await handle.write(Buffer.from(bytes));
  } finally {
    await handle.close();
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown printer error').slice(0, 500);
}

function bridgeEndpoint(baseUrl: string, wait?: number): URL {
  const endpoint = new URL('/api/restaurant/print-bridge', baseUrl);
  if (wait !== undefined) endpoint.searchParams.set('wait', String(wait));
  return endpoint;
}

export async function runPrintBridge(input: {
  baseUrl: string;
  token: string;
  signal?: AbortSignal;
}): Promise<void> {
  let failures = 0;
  const headers = { Authorization: `Bearer ${input.token}` };
  while (!input.signal?.aborted) {
    try {
      const response = await fetch(bridgeEndpoint(input.baseUrl, 20), {
        headers,
        signal: input.signal,
      });
      if (response.status === 204) {
        failures = 0;
        continue;
      }
      if (!response.ok) throw new Error(`Claim failed with HTTP ${response.status}.`);
      const payload = (await response.json()) as { job?: BridgeJob };
      if (!payload.job) throw new Error('Claim response did not include a job.');

      let status: 'PRINTED' | 'OFFLINE' = 'PRINTED';
      let errorText: string | undefined;
      try {
        await writeToPrinter(payload.job.address, Buffer.from(payload.job.bytes, 'base64'));
      } catch (error) {
        status = 'OFFLINE';
        errorText = safeError(error);
      }
      const acknowledgement = await fetch(bridgeEndpoint(input.baseUrl), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: payload.job.id,
          status,
          ...(errorText ? { error: errorText } : {}),
        }),
        signal: input.signal,
      });
      if (!acknowledgement.ok) {
        throw new Error(`Acknowledgement failed with HTTP ${acknowledgement.status}.`);
      }
      failures = status === 'PRINTED' ? 0 : Math.min(failures + 1, 6);
    } catch (error) {
      if (input.signal?.aborted) break;
      failures = Math.min(failures + 1, 6);
      console.error(`Print bridge retrying: ${safeError(error)}`);
    }
    if (failures > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** failures)));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const baseUrl = process.env.PRINT_BRIDGE_BASE_URL;
  let token = process.env.PRINT_BRIDGE_TOKEN;
  const tokenFile = process.env.PRINT_BRIDGE_TOKEN_FILE;
  const enrollmentCode = process.env.PRINT_BRIDGE_ENROLLMENT_CODE;
  if (!token && tokenFile) {
    try {
      token = await readPrintBridgeToken(tokenFile);
    } catch (error) {
      if (!enrollmentCode)
        console.error(`Could not read PRINT_BRIDGE_TOKEN_FILE: ${safeError(error)}`);
    }
  }
  if (baseUrl && !token && enrollmentCode && !tokenFile) {
    console.error(
      'Set PRINT_BRIDGE_TOKEN_FILE to a new path before enrollment so the token can be stored securely.'
    );
  }
  if (baseUrl && !token && enrollmentCode && tokenFile) {
    let handle;
    let reservedTokenFile = false;
    try {
      handle = await open(tokenFile, 'wx', 0o600);
      reservedTokenFile = true;
      const response = await fetch(new URL('/api/restaurant/print-bridge/enroll', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: enrollmentCode }),
      });
      if (!response.ok) throw new Error(`Enrollment failed with HTTP ${response.status}.`);
      token = ((await response.json()) as { token: string }).token;
      if (!token.startsWith('rdk_'))
        throw new Error('Enrollment returned an invalid device token.');
      await handle.writeFile(`${token}\n`, 'utf8');
      console.log(`Enrollment succeeded. Device token stored in ${tokenFile}.`);
    } catch (error) {
      token = undefined;
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (reservedTokenFile) await unlink(tokenFile).catch(() => undefined);
      console.error(`Could not enroll and persist PRINT_BRIDGE_TOKEN_FILE: ${safeError(error)}`);
    } finally {
      await handle?.close();
    }
  }
  if (!baseUrl || !token) {
    console.error(
      'Set PRINT_BRIDGE_BASE_URL plus PRINT_BRIDGE_TOKEN_FILE and PRINT_BRIDGE_ENROLLMENT_CODE (first run), or use PRINT_BRIDGE_TOKEN/PRINT_BRIDGE_TOKEN_FILE later.'
    );
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    void runPrintBridge({ baseUrl, token, signal: controller.signal }).catch((error) => {
      console.error(`Print bridge stopped: ${safeError(error)}`);
      process.exitCode = 1;
    });
  }
}
