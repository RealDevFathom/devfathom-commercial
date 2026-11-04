import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';

export const PATH = 'pharmacy/branch-1/counter-1';
export const USERNAME = 'snapshot-reader-7f3a';
export const SECRET = 'S3cret-reader-value-0123456789-abcdefXYZ';
export const STDERR_MARKER = 'rtsp://leaky:hunter2@127.0.0.1:8554/should-never-appear';

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
export const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

export function rawConfig(overrides: Record<string, unknown> = {}) {
  return {
    listen: { host: '10.0.0.10', port: 8899 },
    tls: {
      certFile: '/etc/devfathom-snapshot/tls.crt',
      keyFile: '/etc/devfathom-snapshot/tls.key',
    },
    rtspOrigin: 'rtsp://127.0.0.1:8554',
    ffmpegPath: '/usr/bin/ffmpeg',
    paths: [{ path: PATH, username: USERNAME, passwordSha256: sha256Hex(SECRET) }],
    ...overrides,
  };
}

function pngChunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A complete, valid RGB PNG with CRCs. */
export function makePng(width = 4, height = 3): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill = (signal?: string) => {
    this.killed.push(String(signal));
    setImmediate(() => this.emit('close', null, signal ?? 'SIGTERM'));
    return true;
  };

  /** Write stdout, then exit with `code`. */
  async finish(bytes: Buffer, code = 0) {
    this.stderr.write(STDERR_MARKER);
    this.stdout.write(bytes);
    await tick();
    this.stdout.end();
    this.stderr.end();
    await tick();
    this.emit('close', code, null);
    await tick();
  }
}

export type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> };

export function fakeSpawn() {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = (command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

export class FakeRes extends EventEmitter {
  status: number | null = null;
  headers: Record<string, string> = {};
  body: Buffer | null = null;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  end(body?: Buffer | string) {
    this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    this.writableEnded = true;
    this.emit('finish');
    this.emit('close');
    return this;
  }
}

export function fakeReq(url: string, authorization?: string, method = 'GET') {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.method = method;
  req.url = url;
  req.headers = authorization === undefined ? {} : { authorization };
  req.resume = () => req;
  return req;
}
