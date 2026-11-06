import { request as httpsRequest } from 'node:https';
import { isIPv4 } from 'node:net';

import { CAMERA_SNAPSHOT_MAX_BYTES } from './png-still';

/**
 * DEV-745 — scope-bound still reads from the gateway-side snapshot service
 * (`docker/camera-snapshot-gateway`). MediaMTX has no still endpoint, so the
 * gateway host runs that service next to it; this module is the app half.
 *
 * `CAMERA_SNAPSHOT_BINDINGS` is a server-only JSON allowlist, separate from the
 * HLS bindings so snapshot reader credentials stay separate and a camera takes
 * stills only when its owner explicitly provisions it. A camera with no binding
 * is unsupported; nothing here ever resolves a bare camera reference.
 */

export type CameraSnapshotScope = {
  vertical: 'pharmacy';
  organizationId: string;
  branchId: string;
  gatewayId: string;
  /** The camera row id, as in the DEV-740 stream route. */
  cameraId: string;
  /** The registered gateway URL. Matched exactly; never requested. */
  baseUrl: string;
};

type SnapshotBinding = CameraSnapshotScope & {
  snapshotBaseUrl: string;
  address: string;
  path: string;
  username: string;
  password: string;
};

export type CameraSnapshotFailure =
  'not-configured' | 'unsupported' | 'auth-failed' | 'gateway-unreachable' | 'invalid-still';

/** Carries a stable code and nothing else: no URL, host, path or credential. */
export class CameraSnapshotError extends Error {
  constructor(readonly code: CameraSnapshotFailure) {
    super(code);
    this.name = 'CameraSnapshotError';
  }
}

/**
 * The gateway service's hard deadline is its ffmpeg timeout (1–8 s) plus 1 s;
 * this leaves room above the 9 s maximum for TLS and transfer.
 */
export const CAMERA_SNAPSHOT_DEADLINE_MS = 10_000;
const MAX_ACTIVE = 4;
const MAX_BINDINGS = 256;
const PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const KEYS = [
  'vertical',
  'organizationId',
  'branchId',
  'gatewayId',
  'cameraId',
  'baseUrl',
  'snapshotBaseUrl',
  'address',
  'path',
  'username',
  'password',
] as const;

/** Exactly `https://hostname[:port]/`: no IP literal, credentials, path, query or fragment. */
function httpsOrigin(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' &&
    /^[a-z][a-z0-9.-]*$/i.test(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === '/' &&
    url.href === value
    ? url
    : null;
}

/** RFC1918 IPv4 only: no DNS, loopback, link-local, metadata or public targets. */
function isPrivateIPv4(value: string): boolean {
  if (!isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function parseBindings(raw: string): SnapshotBinding[] {
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_BINDINGS) throw new Error();
    const cameras = new Set<string>();
    const streams = new Set<string>();
    return rows.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const row = value as Record<string, unknown>;
      const keys = Object.keys(row);
      if (
        keys.length !== KEYS.length ||
        keys.some((key) => !(KEYS as readonly string[]).includes(key))
      )
        throw new Error();
      for (const key of KEYS) {
        const field = row[key];
        if (typeof field !== 'string' || !field || field.length > 1024 || /[\r\n\0]/.test(field))
          throw new Error();
      }
      const binding = row as unknown as SnapshotBinding;
      if (binding.vertical !== 'pharmacy') throw new Error();
      for (const key of ['organizationId', 'branchId', 'gatewayId', 'cameraId'] as const)
        if (binding[key].length > 128) throw new Error();
      const base = httpsOrigin(binding.baseUrl);
      const snapshot = httpsOrigin(binding.snapshotBaseUrl);
      // One certificate identity: the snapshot service lives on the gateway host.
      if (!base || !snapshot || snapshot.hostname !== base.hostname) throw new Error();
      if (!isPrivateIPv4(binding.address)) throw new Error();
      if (binding.path.length > 120 || !PATH.test(binding.path)) throw new Error();
      // Printable ASCII: the gateway compares bytes, so nothing else could ever match.
      if (binding.username.length > 256 || !/^[\x21-\x39\x3b-\x7e]+$/.test(binding.username))
        throw new Error();
      // A generated reader secret (32+ printable ASCII, as the gateway README
      // generates); the gateway compares bytes, so non-ASCII could never match.
      if (binding.password.length < 32 || !/^[\x21-\x7e]+$/.test(binding.password))
        throw new Error();
      const cameraKey = JSON.stringify([binding.organizationId, binding.cameraId]);
      const streamKey = `${snapshot.origin}/${binding.path}`;
      if (cameras.has(cameraKey) || streams.has(streamKey)) throw new Error();
      cameras.add(cameraKey);
      streams.add(streamKey);
      return { ...binding };
    });
  } catch {
    throw new CameraSnapshotError('not-configured');
  }
}

export function createCameraSnapshotTransport(raw: string, request = httpsRequest) {
  const bindings = parseBindings(raw);
  let active = 0;

  const find = (scope: CameraSnapshotScope) =>
    bindings.find(
      (row) =>
        scope.vertical === 'pharmacy' &&
        row.organizationId === scope.organizationId &&
        row.branchId === scope.branchId &&
        row.gatewayId === scope.gatewayId &&
        row.cameraId === scope.cameraId &&
        row.baseUrl === scope.baseUrl
    );

  return {
    /** True only when this exact camera scope was provisioned for stills. */
    supports(scope: CameraSnapshotScope): boolean {
      return Boolean(find(scope));
    },

    /**
     * Fetch one still for an already-authorized scope. Returns the bytes as sent;
     * the evidence store validates them as a PNG before anything is kept.
     */
    async readSnapshot(scope: CameraSnapshotScope): Promise<Uint8Array> {
      const binding = find(scope);
      if (!binding) throw new CameraSnapshotError('unsupported');
      if (active >= MAX_ACTIVE) throw new CameraSnapshotError('gateway-unreachable');
      const target = new URL(`${binding.path}/snapshot.png`, binding.snapshotBaseUrl);
      active++;
      try {
        return await new Promise<Uint8Array>((resolve, reject) => {
          let settled = false;
          const fail = (code: CameraSnapshotFailure) => {
            if (settled) return;
            settled = true;
            reject(new CameraSnapshotError(code));
          };
          const req = request(
            target,
            {
              method: 'GET',
              agent: false,
              family: 4,
              rejectUnauthorized: true,
              // Connect only to the pinned private address; TLS still verifies the hostname.
              lookup: (_host, _options, callback) => callback(null, binding.address, 4),
              headers: {
                Authorization: `Basic ${Buffer.from(`${binding.username}:${binding.password}`).toString('base64')}`,
                Accept: 'image/png',
                'Accept-Encoding': 'identity',
              },
            },
            (res) => {
              const status = res.statusCode ?? 0;
              const type = String(res.headers['content-type'] ?? '')
                .split(';', 1)[0]
                .trim()
                .toLowerCase();
              const declared = Number(res.headers['content-length'] ?? 0);
              if (
                status !== 200 ||
                type !== 'image/png' ||
                res.headers['content-encoding'] ||
                !Number.isFinite(declared) ||
                declared > CAMERA_SNAPSHOT_MAX_BYTES
              ) {
                // Redirects are never followed: any 3xx is a gateway fault.
                fail(
                  status === 401 || status === 403
                    ? 'auth-failed'
                    : status === 404
                      ? 'unsupported'
                      : status === 200
                        ? 'invalid-still'
                        : 'gateway-unreachable'
                );
                res.destroy();
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > CAMERA_SNAPSHOT_MAX_BYTES) {
                  fail('invalid-still');
                  res.destroy();
                } else chunks.push(chunk);
              });
              res.on('error', () => fail('gateway-unreachable'));
              res.on('end', () => {
                if (settled) return;
                if (!res.complete) return fail('gateway-unreachable');
                settled = true;
                resolve(new Uint8Array(Buffer.concat(chunks)));
              });
              // A connection dropped mid-body ends without 'end'.
              res.on('close', () => fail('gateway-unreachable'));
            }
          );
          const timer = setTimeout(() => {
            fail('gateway-unreachable');
            req.destroy();
          }, CAMERA_SNAPSHOT_DEADLINE_MS);
          req.on('error', () => fail('gateway-unreachable'));
          req.on('close', () => clearTimeout(timer));
          req.end();
        });
      } finally {
        active--;
      }
    },
  };
}

export type CameraSnapshotTransport = ReturnType<typeof createCameraSnapshotTransport>;
