// DEV-745 camera snapshot gateway.
//
// Runs on the on-prem gateway host next to MediaMTX and answers
// `GET /<path>/snapshot.png` with one PNG frame taken from MediaMTX's own
// loopback RTSP output. It never reads recordings, never calls the MediaMTX
// API or playback server, never talks to a DVR, and never writes to disk.
//
// Plain Node 22 ESM with zero npm dependencies.

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { isIPv4 } from 'node:net';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ path: string, username: string, passwordSha256: string }} PathEntry
 * @typedef {{
 *   listen: { host: string, port: number },
 *   tls: { certFile: string, keyFile: string },
 *   rtspOrigin: string,
 *   rtspReader: { username: string, password: string },
 *   ffmpegPath: string,
 *   timeoutMs: number,
 *   maxBytes: number,
 *   maxConcurrent: number,
 *   maxWidth: number,
 *   paths: readonly PathEntry[],
 * }} SnapshotConfig
 * @typedef {{ at: string, path: string | null, status: number, ms: number, bytes: number }} LogEntry
 * @typedef {(entry: LogEntry) => void} Logger
 * @typedef {(command: string, args: string[], options: object) => any} SpawnFn
 */

const CONFIG_ERROR = 'Invalid snapshot gateway configuration.';
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const MAX_PNG_DIMENSION = 4096;
const MAX_PNG_CHUNKS = 4096;
const PATH_PATTERN = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const URL_PATTERN = /^\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)\/snapshot\.png$/;
const RTSP_ORIGIN_PATTERN = /^rtsp:\/\/(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
// MediaMTX reader credential: URL-safe characters only, so it never needs escaping.
const READER_USER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const READER_PASS_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
// Printable ASCII without ':' (Basic auth separator); compared byte for byte.
const USERNAME_PATTERN = /^[\x21-\x39\x3b-\x7e]{1,256}$/;
/** The shipped examples' placeholders must never be accepted as real secrets. */
const isPlaceholder = (/** @type {string} */ value) => /replace/i.test(value) || /^0+$/.test(value);
const MIN_FFMPEG_MAJOR = 5;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REALM = 'Basic realm="camera-snapshot"';
const FFMPEG_ENV = Object.freeze({ PATH: '/usr/bin:/bin' });

const TOP_KEYS = [
  'listen',
  'tls',
  'rtspOrigin',
  'rtspReader',
  'ffmpegPath',
  'timeoutMs',
  'maxBytes',
  'maxConcurrent',
  'maxWidth',
  'paths',
];

/** Fixed bodies: nothing from the request or from ffmpeg is ever echoed. */
const BODIES = Object.freeze({
  404: 'Not found\n',
  405: 'Method not allowed\n',
  401: 'Unauthorized\n',
  502: 'Bad gateway\n',
  503: 'Busy\n',
  504: 'Gateway timeout\n',
});

function fail() {
  throw new Error(CONFIG_ERROR);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} object
 * @param {readonly string[]} allowed
 * @param {readonly string[]} required
 */
function checkKeys(object, allowed, required) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail();
  for (const key of required) if (!Object.hasOwn(object, key)) fail();
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} [fallback]
 */
function integer(value, min, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail();
  return /** @type {number} */ (value);
}

/** @param {unknown} value */
function absolutePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\0\r\n]/.test(value) ||
    !isAbsolute(value)
  )
    fail();
  return /** @type {string} */ (value);
}

/**
 * Parse and validate the gateway configuration. Unknown keys are rejected at
 * every level. The error never echoes any part of the input.
 *
 * @param {string} raw
 * @returns {Readonly<SnapshotConfig>}
 */
export function parseConfig(raw) {
  try {
    if (typeof raw !== 'string') fail();
    /** @type {unknown} */
    const data = JSON.parse(raw);
    if (!isPlainObject(data)) fail();
    const root = /** @type {Record<string, unknown>} */ (data);
    checkKeys(root, TOP_KEYS, ['listen', 'tls', 'rtspOrigin', 'rtspReader', 'ffmpegPath', 'paths']);

    if (!isPlainObject(root.listen)) fail();
    const listen = /** @type {Record<string, unknown>} */ (root.listen);
    checkKeys(listen, ['host', 'port'], ['host', 'port']);
    if (typeof listen.host !== 'string' || !isIPv4(listen.host)) fail();
    const port = integer(listen.port, 1, 65535);

    if (!isPlainObject(root.tls)) fail();
    const tls = /** @type {Record<string, unknown>} */ (root.tls);
    checkKeys(tls, ['certFile', 'keyFile'], ['certFile', 'keyFile']);

    if (typeof root.rtspOrigin !== 'string') fail();
    const origin = RTSP_ORIGIN_PATTERN.exec(/** @type {string} */ (root.rtspOrigin));
    if (!origin) fail();
    integer(Number(/** @type {RegExpExecArray} */ (origin)[1]), 1, 65535);

    // A dedicated MediaMTX reader, never an anonymous loopback grant: a reverse
    // proxy on this host would otherwise make every LAN client look like loopback.
    if (!isPlainObject(root.rtspReader)) fail();
    const reader = /** @type {Record<string, unknown>} */ (root.rtspReader);
    checkKeys(reader, ['username', 'password'], ['username', 'password']);
    if (typeof reader.username !== 'string' || !READER_USER_PATTERN.test(reader.username)) fail();
    if (
      typeof reader.password !== 'string' ||
      !READER_PASS_PATTERN.test(reader.password) ||
      isPlaceholder(reader.password)
    )
      fail();

    if (!Array.isArray(root.paths) || root.paths.length < 1 || root.paths.length > 256) fail();
    const seen = new Set();
    const paths = /** @type {unknown[]} */ (root.paths).map((value) => {
      if (!isPlainObject(value)) fail();
      const entry = /** @type {Record<string, unknown>} */ (value);
      const keys = ['path', 'username', 'passwordSha256'];
      checkKeys(entry, keys, keys);
      const { path, username, passwordSha256 } = entry;
      if (typeof path !== 'string' || path.length > 120 || !PATH_PATTERN.test(path)) fail();
      if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) fail();
      if (
        typeof passwordSha256 !== 'string' ||
        !HASH_PATTERN.test(passwordSha256) ||
        isPlaceholder(passwordSha256)
      )
        fail();
      if (seen.has(path)) fail();
      seen.add(path);
      return Object.freeze(
        /** @type {PathEntry} */ ({
          path: /** @type {string} */ (path),
          username: /** @type {string} */ (username),
          passwordSha256: /** @type {string} */ (passwordSha256),
        })
      );
    });

    return Object.freeze({
      listen: Object.freeze({ host: /** @type {string} */ (listen.host), port }),
      tls: Object.freeze({
        certFile: absolutePath(tls.certFile),
        keyFile: absolutePath(tls.keyFile),
      }),
      rtspOrigin: /** @type {string} */ (root.rtspOrigin),
      rtspReader: Object.freeze({
        username: /** @type {string} */ (reader.username),
        password: /** @type {string} */ (reader.password),
      }),
      ffmpegPath: absolutePath(root.ffmpegPath),
      timeoutMs: integer(root.timeoutMs, 1000, 8000, 4000),
      maxBytes: integer(root.maxBytes, 1, MAX_PNG_BYTES, MAX_PNG_BYTES),
      maxConcurrent: integer(root.maxConcurrent, 1, 4, 2),
      // A noisy 1080p PNG can exceed 4 MiB; 1280 keeps real stills well inside it.
      maxWidth: integer(root.maxWidth, 160, 1920, 1280),
      paths: Object.freeze(paths),
    });
  } catch {
    // Swallow JSON.parse and validation detail alike: no echo of the input.
    throw new Error(CONFIG_ERROR);
  }
}

/**
 * The exact ffmpeg argument vector for one still. Pure; `path` must be a
 * configured path (it is re-checked against the path grammar).
 *
 * The MediaMTX reader credential is in the URL argument. The systemd unit's
 * ProtectProc=invisible hides the process from other users, and stderr (which
 * can echo the URL) is never read or logged.
 *
 * @param {Pick<SnapshotConfig, 'rtspOrigin' | 'rtspReader' | 'timeoutMs' | 'maxWidth'>} config
 * @param {string} path
 * @returns {string[]}
 */
export function ffmpegArgs(config, path) {
  if (typeof path !== 'string' || path.length > 120 || !PATH_PATTERN.test(path)) {
    throw new Error('Invalid snapshot path.');
  }
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    // One decoder and filter thread: bounded tasks under the unit's TasksMax.
    '-filter_threads',
    '1',
    '-threads',
    '1',
    '-rtsp_transport',
    'tcp',
    '-timeout',
    String(config.timeoutMs * 1000),
    '-i',
    `${config.rtspOrigin.replace(
      'rtsp://',
      `rtsp://${config.rtspReader.username}:${config.rtspReader.password}@`
    )}/${path}`,
    '-frames:v',
    '1',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `scale='min(${config.maxWidth},iw)':-2`,
    '-f',
    'image2pipe',
    '-c:v',
    'png',
    'pipe:1',
  ];
}

/** @type {Uint32Array | null} */
let crcTable = null;

/** @param {Buffer} bytes */
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Structural PNG check: signature, IHDR first (length 13, 1..4096 each way),
 * every chunk in bounds with a valid CRC, at least one IDAT, and a final
 * zero-length IEND with nothing after it. It does not decode pixel data.
 *
 * @param {unknown} buffer
 * @param {number} [maxBytes]
 * @returns {boolean}
 */
export function isPngStill(buffer, maxBytes = MAX_PNG_BYTES) {
  if (!(buffer instanceof Uint8Array)) return false;
  const png = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (png.length < 8 + 25 + 12 || png.length > Math.min(maxBytes, MAX_PNG_BYTES)) return false;
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let sawData = false;
  for (let count = 0; count < MAX_PNG_CHUNKS && offset + 12 <= png.length; count++) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > png.length) return false;
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(end - 4)) {
      return false;
    }
    if (count === 0) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = png.readUInt32BE(offset + 8);
      const height = png.readUInt32BE(offset + 12);
      if (width < 1 || height < 1 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
        return false;
      }
    } else if (type === 'IHDR') {
      return false;
    } else if (type === 'IDAT') {
      sawData = true;
    } else if (type === 'IEND') {
      return length === 0 && end === png.length && sawData;
    }
    offset = end;
  }
  return false;
}

/** @type {Logger} */
function defaultJsonLineLogger(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Extract `username:password` from a Basic Authorization header, or null.
 *
 * @param {unknown} header
 * @returns {{ username: string, password: string } | null}
 */
function basicCredentials(header) {
  if (typeof header !== 'string' || header.length > 2048) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return null;
  // latin1 maps bytes 1:1, so distinct byte strings never compare equal.
  const decoded = Buffer.from(match[1], 'base64').toString('latin1');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * Build the request handler. Dependencies are injectable for tests.
 *
 * @param {{ config: Readonly<SnapshotConfig>, spawn?: SpawnFn, log?: Logger, now?: () => number }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createSnapshotHandler({
  config,
  spawn = nodeSpawn,
  log = defaultJsonLineLogger,
  now = Date.now,
}) {
  /** Per path: sha256(username) and sha256(password), both 32 bytes. */
  const credentials = new Map(
    config.paths.map((entry) => [
      entry.path,
      { user: sha256(entry.username), pass: Buffer.from(entry.passwordSha256, 'hex') },
    ])
  );
  // Compared against for unknown paths so the hash work is identical.
  const decoy = { user: randomBytes(32), pass: randomBytes(32) };
  let active = 0;

  return function handleSnapshot(req, res) {
    const started = now();
    /** @type {string | null} */
    let loggedPath = null;
    let done = false;

    /**
     * Send one response and write exactly one log line.
     * @param {number} status
     * @param {Buffer | null} [image]
     * @param {Record<string, string>} [extra]
     */
    const finish = (status, image = null, extra = {}) => {
      if (done) return;
      done = true;
      log({
        at: new Date(now()).toISOString(),
        path: loggedPath,
        status,
        ms: Math.max(0, now() - started),
        bytes: image ? image.length : 0,
      });
      if (status === 499 || res.headersSent || res.writableEnded || res.destroyed) return;
      const body = image ?? Buffer.from(BODIES[/** @type {keyof typeof BODIES} */ (status)]);
      res.writeHead(status, {
        'Content-Type': image ? 'image/png' : 'text/plain; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        Connection: 'close',
        ...extra,
      });
      res.end(body);
    };

    // A GET carries no body; drain anything sent so the socket can close.
    if (typeof req.resume === 'function') req.resume();

    if (req.method !== 'GET') return finish(405, null, { Allow: 'GET' });

    const url = typeof req.url === 'string' && req.url.length <= 160 ? req.url : '';
    const match = URL_PATTERN.exec(url);
    if (!match || match[1].length > 120) return finish(404);
    const path = match[1];

    const known = credentials.get(path);
    const expected = known ?? decoy;
    const presented = basicCredentials(req.headers?.authorization);
    // Always hash and compare, whatever was presented and whether the path exists.
    const userOk = timingSafeEqual(sha256(presented?.username ?? ''), expected.user);
    const passOk = timingSafeEqual(sha256(presented?.password ?? ''), expected.pass);
    if (known) loggedPath = path;
    if (!known || !presented || !userOk || !passOk) {
      return finish(401, null, { 'WWW-Authenticate': REALM });
    }

    if (active >= config.maxConcurrent) return finish(503, null, { 'Retry-After': '1' });

    /** @type {any} */
    let child;
    try {
      child = spawn(config.ffmpegPath, ffmpegArgs(config, path), {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...FFMPEG_ENV },
      });
    } catch {
      return finish(502);
    }
    active++;

    let exited = false;
    const kill = () => {
      if (exited) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(504);
    }, config.timeoutMs + 1000);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      clearTimeout(timer);
    };

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > config.maxBytes) {
        kill();
        finish(502);
        return;
      }
      chunks.push(chunk);
    });
    child.stdout?.on('error', () => {});
    // stderr may contain the RTSP URL or credentials: drain it, never read it.
    child.stderr?.on('error', () => {});
    child.stderr?.resume();

    child.on('error', () => {
      // Never spawned: nothing to wait for. Otherwise it may still be running:
      // kill it and keep the slot until 'close' confirms it is gone.
      if (child.pid === undefined) {
        exited = true;
        release();
      } else kill();
      finish(502);
    });
    child.on('close', (/** @type {number | null} */ code) => {
      exited = true;
      release();
      if (done) return;
      const image = Buffer.concat(chunks, size);
      if (code === 0 && isPngStill(image, config.maxBytes)) finish(200, image);
      else finish(502);
    });

    // The client went away before we answered: stop ffmpeg now.
    res.on('close', () => {
      if (done) return;
      kill();
      finish(499);
    });
  };
}

/**
 * Create (but do not start) the HTTPS server with the hardened options.
 *
 * @param {Readonly<SnapshotConfig>} config
 * @param {{ spawn?: SpawnFn, log?: Logger, now?: () => number }} [deps]
 */
export function createGatewayServer(config, deps = {}) {
  const server = createServer(
    {
      cert: readFileSync(config.tls.certFile),
      key: readFileSync(config.tls.keyFile),
      minVersion: 'TLSv1.2',
      handshakeTimeout: 5_000,
      requestTimeout: 10_000,
      headersTimeout: 5_000,
      // Enforce the two timeouts every second, not every 30 s (Node's default).
      connectionsCheckingInterval: 1_000,
      maxHeaderSize: 8192,
      keepAlive: false,
    },
    createSnapshotHandler({ config, ...deps })
  );
  server.keepAliveTimeout = 0;
  server.maxRequestsPerSocket = 1;
  server.maxConnections = 64;
  return server;
}

/**
 * ffmpeg before 5.0 reads the RTSP `-timeout` option as listen mode (it would
 * bind MediaMTX's port instead of reading from it), so older builds are refused.
 *
 * @param {string} versionOutput the first line of `ffmpeg -version`
 * @returns {boolean}
 */
export function isSupportedFfmpegVersion(versionOutput) {
  const major = /^ffmpeg version n?(\d+)\./.exec(String(versionOutput))?.[1];
  return major !== undefined && Number(major) >= MIN_FFMPEG_MAJOR;
}

/**
 * Read the config named by SNAPSHOT_GATEWAY_CONFIG and start listening.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<import('node:https').Server>}
 */
export async function main(env = process.env) {
  const file = env.SNAPSHOT_GATEWAY_CONFIG;
  if (!file) throw new Error(CONFIG_ERROR);
  const config = parseConfig(readFileSync(file, 'utf8'));
  const version = execFileSync(config.ffmpegPath, ['-version'], {
    env: { ...FFMPEG_ENV },
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString('utf8');
  if (!isSupportedFfmpegVersion(version)) {
    throw Object.assign(new Error(CONFIG_ERROR), { code: 'FFMPEG_VERSION_UNSUPPORTED' });
  }
  const server = createGatewayServer(config);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((/** @type {any} */ error) => {
    const code =
      error && typeof error.code === 'string' ? error.code : 'INVALID_CONFIGURATION_OR_STARTUP';
    process.stderr.write(
      `${JSON.stringify({ at: new Date().toISOString(), event: 'startup-failed', code })}\n`
    );
    process.exit(1);
  });
}
