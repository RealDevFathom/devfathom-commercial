import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { checkServerIdentity, createSecureContext, TLSSocket } from 'node:tls';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import type {
  FreshDatabaseEndpoint,
  FreshDatabaseFactory,
  FreshDatabaseLease,
} from './fresh-database.js';

// pg 8.22.0 internals are deliberately isolated here; upgrade requires the lifecycle tests.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Outcome = 'NOT_STARTED' | 'ROLLED_BACK' | 'COMMITTED' | 'UNKNOWN';
type Control = { signal: AbortSignal; deadlineAt: number; endpoint: FreshDatabaseEndpoint };
const rejected = () => new Error('Private initializer driver rejected operation.');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function assertLockedDrivers() {
  const require = createRequire(import.meta.url);
  const pgRoot = dirname(require.resolve('pg/package.json'));
  const adapterRoot = join(dirname(require.resolve('@prisma/adapter-pg')), '..');
  if (
    JSON.parse(readFileSync(join(pgRoot, 'package.json'), 'utf8')).version !== '8.22.0' ||
    JSON.parse(readFileSync(join(adapterRoot, 'package.json'), 'utf8')).version !== '7.9.1' ||
    JSON.parse(readFileSync(require.resolve('@prisma/client/package.json'), 'utf8')).version !==
      '7.9.1'
  )
    throw rejected();
  const pins: Array<[string, string]> = [
    [
      join(pgRoot, 'lib/client.js'),
      '86cda0e1fda47e03d27dde65f10c7b9d597f7411f77ed853c8d27d5f150978a2',
    ],
    [
      join(pgRoot, 'lib/query.js'),
      '4253bb48364243573c330a2d5827a0f306f632f84f5ac56feaa3ac83f2293001',
    ],
    [
      join(pgRoot, 'lib/connection.js'),
      '5c17c585f307518f8369d6162d138c58eef1309128ad2fae2d6b315c8000234e',
    ],
    [
      join(pgRoot, 'lib/connection-parameters.js'),
      '6b6548f99acba3502663a17a180582ba8e1f1725aa9d94b5f47cac19dcb6211b',
    ],
    [
      require.resolve('pg-pool'),
      '6f304776edaabde2954cbf8c4366fa6d9512bfba0e408e78cc56b3c46c69d058',
    ],
    [
      require.resolve('@prisma/adapter-pg'),
      '1a7a1cce1bdb10f60e6230cd30a1571d93ebf3e4590416fe4928468be1b73b12',
    ],
  ];
  for (const [path, expected] of pins) if (sha(readFileSync(path)) !== expected) throw rejected();
}

export function privatePoolConfig(urlString: string, control: Control, ca: Buffer): pg.PoolConfig {
  if (
    Object.keys(process.env).some(
      (key) => key.startsWith('PG') || ['DEBUG', 'NODE_DEBUG'].includes(key)
    )
  )
    throw rejected();
  const url = new URL(urlString);
  const e = control.endpoint;
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== e.hostname ||
    Number(url.port || 5432) !== e.port ||
    url.pathname !== `/${e.database}` ||
    e.hostname !== e.tlsServerName ||
    !/^[a-zA-Z0-9.-]+$/.test(e.hostname) ||
    decodeURIComponent(url.username) !== 'devfathom_app' ||
    !url.password ||
    url.hash ||
    url.search !== '?sslmode=verify-full' ||
    sha(ca) !== e.caSha256 ||
    !Number.isSafeInteger(control.deadlineAt) ||
    control.signal.aborted ||
    Date.now() >= control.deadlineAt
  )
    throw rejected();
  createSecureContext({ ca, minVersion: 'TLSv1.2' });
  const remaining = Math.max(1, control.deadlineAt - Date.now());
  // Never pass connectionString: pg parses it over explicit CA and TLS options.
  return {
    host: e.hostname,
    port: e.port,
    database: e.database,
    user: 'devfathom_app',
    password: decodeURIComponent(url.password),
    max: 1,
    connectionTimeoutMillis: remaining,
    query_timeout: 0,
    statement_timeout: remaining,
    lock_timeout: remaining,
    options: '-c search_path=pg_catalog,public',
    client_encoding: 'UTF8',
    idle_in_transaction_session_timeout: remaining,
    application_name: 'fresh-restaurant-initializer',
    ssl: {
      ca: Buffer.from(ca),
      rejectUnauthorized: true,
      servername: e.tlsServerName,
      minVersion: 'TLSv1.2',
      checkServerIdentity,
    },
  };
}

export function verifyOwnedTLS(
  client: any,
  connection: any,
  config: pg.PoolConfig,
  endpoint: FreshDatabaseEndpoint
) {
  const socket = connection.stream;
  const ssl = client.connectionParameters.ssl;
  if (
    connection !== client.connection ||
    !(socket instanceof TLSSocket) ||
    !socket.encrypted ||
    !socket.authorized ||
    socket.authorizationError ||
    socket.destroyed ||
    socket.remotePort !== endpoint.port ||
    socket.servername !== endpoint.tlsServerName ||
    !socket.remoteAddress ||
    ssl !== connection.ssl ||
    ssl.rejectUnauthorized !== true ||
    ssl.checkServerIdentity !== checkServerIdentity ||
    !Buffer.isBuffer(ssl.ca) ||
    sha(ssl.ca) !== endpoint.caSha256 ||
    ssl.servername !== endpoint.tlsServerName ||
    client.host !== endpoint.hostname ||
    Number(client.port) !== endpoint.port ||
    client.database !== endpoint.database ||
    config.host !== client.host ||
    client.user !== 'devfathom_app' ||
    !Number.isInteger(client.processID) ||
    checkServerIdentity(endpoint.tlsServerName, socket.getPeerCertificate(true))
  )
    throw rejected();
  return {
    backendPid: client.processID as number,
    remoteAddress: socket.remoteAddress,
    peerSha256: sha(socket.getPeerCertificate(true).raw),
    caSha256: endpoint.caSha256,
  };
}

/** Tracks physical dispatch/ACK, never equates socket closure with server rollback. */
export class DispatchBarrier {
  cancelled = false;
  began = false;
  commitSent = false;
  outcome: Outcome = 'NOT_STARTED';
  readonly pending = new Set<Promise<unknown>>();
  constructor(readonly control: Control) {}
  check() {
    if (this.control.signal.aborted || Date.now() >= this.control.deadlineAt) this.cancelled = true;
    if (this.cancelled) throw rejected();
  }
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise)
    );
    return promise;
  }
  async settle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  instrument(query: any, client: any, verify: () => void) {
    const submit = query.submit.bind(query);
    const callback = query.callback;
    let sent = false;
    const command = query.text.trim().replace(/;$/, '').toUpperCase();
    query.submit = (connection: any) => {
      try {
        this.check();
        if (connection !== client.connection) throw rejected();
        verify();
        sent = true;
        if (command === 'BEGIN') {
          this.began = true;
          this.outcome = 'UNKNOWN';
        }
        if (command === 'COMMIT') {
          this.commitSent = true;
          this.outcome = 'UNKNOWN';
        }
        return submit(connection);
      } catch {
        this.cancelled = true;
        return rejected();
      }
    };
    query.callback = (error: unknown, result: any) => {
      if (error) this.cancelled = true;
      if (
        sent &&
        command === 'COMMIT' &&
        !error &&
        result?.command === 'COMMIT' &&
        !this.cancelled &&
        !this.control.signal.aborted &&
        Date.now() < this.control.deadlineAt
      )
        this.outcome = 'COMMITTED';
      if (
        sent &&
        command === 'ROLLBACK' &&
        !error &&
        result?.command === 'ROLLBACK' &&
        !this.commitSent
      )
        this.outcome = 'ROLLED_BACK';
      callback(error ? rejected() : null, result);
    };
  }
}

export function createPrivateFactory(caBytes: Buffer) {
  const ca = Buffer.from(caBytes);
  const transactions = new WeakMap<object, { client: any; lease: PrivateLease }>();
  let latest: PrivateLease | undefined;
  let interrupted = false;
  class PrivateLease implements FreshDatabaseLease {
    readonly barrier: DispatchBarrier;
    readonly clients = new Set<any>();
    readonly checkedOut = new Set<any>();
    readonly socketEnds: Promise<void>[] = [];
    pool?: pg.Pool;
    prisma?: PrismaClient;
    connection?: Promise<any>;
    draining?: Promise<void>;
    closing?: Promise<void>;
    cleanupFailed = false;
    closed = false;
    transactionStarted = false;
    constructor(
      readonly config: pg.PoolConfig,
      readonly control: Control
    ) {
      this.barrier = new DispatchBarrier(control);
      control.signal.addEventListener('abort', this.onAbort, { once: true });
    }
    onAbort = () => {
      void this.cancelAndDrain().catch(() => {
        this.cleanupFailed = true;
      });
    };
    connect() {
      if (this.connection) return this.connection;
      this.connection = this.barrier.track(
        (async () => {
          this.barrier.check();
          const lease = this;
          class OwnedClient extends pg.Client {
            constructor(config: pg.ClientConfig = {}) {
              lease.barrier.check();
              super(config);
              lease.clients.add(this);
              lease.socketEnds.push(new Promise<void>((resolve) => this.once('end', resolve)));
              const raw = this as any;
              const query = raw.query.bind(this);
              raw.query = (config: any, values?: any, callback?: any) => {
                const cb = typeof values === 'function' ? values : callback;
                const promise = new Promise((resolve, reject) => {
                  try {
                    lease.barrier.check();
                    if (config?.query_timeout || config?.submit) throw rejected();
                    const q = new (pg as any).Query(
                      config,
                      typeof values === 'function' ? undefined : values,
                      (error: unknown, result: any) =>
                        error ? reject(rejected()) : resolve(result)
                    );
                    lease.barrier.instrument(q, this, () =>
                      verifyOwnedTLS(this, raw.connection, lease.config, lease.control.endpoint)
                    );
                    query(q);
                  } catch {
                    reject(rejected());
                  }
                });
                lease.barrier.track(promise);
                if (cb) {
                  void promise.then(
                    (r) => cb(null, r),
                    () => cb(rejected())
                  );
                  return;
                }
                return promise;
              };
              this.on('error', () => {
                lease.barrier.cancelled = true;
              });
            }
          }
          try {
            this.pool = new pg.Pool({ ...this.config, Client: OwnedClient } as pg.PoolConfig);
            this.pool.on('error', () => {
              this.barrier.cancelled = true;
            });
            const pool = this.pool as any;
            const connect = pool.connect.bind(pool);
            pool.connect = (callback?: any) => {
              const promise = this.barrier.track(
                (async () => {
                  this.barrier.check();
                  const client = await connect();
                  const release = client.release.bind(client);
                  this.checkedOut.add(client);
                  client.release = (error?: any) => {
                    if (!this.checkedOut.delete(client)) return;
                    release(error || (this.barrier.cancelled ? rejected() : undefined));
                  };
                  try {
                    this.barrier.check();
                    verifyOwnedTLS(client, client.connection, this.config, this.control.endpoint);
                  } catch {
                    client.release(true);
                    throw rejected();
                  }
                  return client;
                })()
              );
              if (callback) {
                void promise.then(
                  (c) => callback(null, c, c.release),
                  () => callback(rejected())
                );
                return;
              }
              return promise;
            };
            this.prisma = new PrismaClient({
              adapter: new PrismaPg(this.pool, { disposeExternalPool: false }),
              log: [],
            });
            await this.prisma.$connect();
            this.barrier.check();
            return {
              $transaction: <T>(
                body: (tx: Prisma.TransactionClient) => Promise<T>,
                options: any
              ) => {
                this.barrier.check();
                if (this.transactionStarted || this.closing) throw rejected();
                this.transactionStarted = true;
                return this.barrier.track(
                  this.prisma!.$transaction(async (tx) => {
                    this.barrier.check();
                    if (this.checkedOut.size !== 1) throw rejected();
                    const client = [...this.checkedOut][0];
                    transactions.set(tx, { client, lease: this });
                    try {
                      return await body(tx);
                    } finally {
                      transactions.delete(tx);
                    }
                  }, options)
                );
              },
            };
          } catch {
            this.barrier.cancelled = true;
            throw rejected();
          }
        })()
      );
      return this.connection;
    }
    cancelAndDrain() {
      this.barrier.cancelled = true;
      if (!this.draining)
        this.draining = (async () => {
          // Destruction interrupts DNS/connect and checked-out sockets. pg callbacks remain the settlement barrier.
          for (const client of this.clients) client.connection.stream.destroy();
          await this.barrier.settle();
          await Promise.all(this.socketEnds);
          for (const client of this.checkedOut) client.release(true);
          if (
            this.barrier.outcome !== 'COMMITTED' &&
            this.barrier.began &&
            this.barrier.outcome !== 'ROLLED_BACK'
          )
            this.barrier.outcome = 'UNKNOWN';
        })().catch(() => {
          this.cleanupFailed = true;
          this.barrier.outcome = 'UNKNOWN';
          throw rejected();
        });
      return this.draining;
    }
    close() {
      if (!this.closing)
        this.closing = (async () => {
          try {
            if (
              this.barrier.cancelled ||
              this.control.signal.aborted ||
              Date.now() >= this.control.deadlineAt
            )
              await this.cancelAndDrain();
            await this.barrier.settle();
            await this.prisma?.$disconnect();
          } catch {
            this.cleanupFailed = true;
          } finally {
            this.barrier.cancelled = true;
            try {
              for (const client of this.clients) client.connection.stream.destroy();
              for (const client of this.checkedOut) client.release(true);
              await this.pool?.end();
              await Promise.all(this.socketEnds);
              await this.barrier.settle();
            } catch {
              this.cleanupFailed = true;
            }
            this.control.signal.removeEventListener('abort', this.onAbort);
            this.closed = true;
          }
          if (this.cleanupFailed) {
            this.barrier.outcome = 'UNKNOWN';
            throw rejected();
          }
        })();
      return this.closing;
    }
  }
  const factory: FreshDatabaseFactory = {
    contract: 'private-runtime-client-cancel-drain-v1',
    create(url, control) {
      if (latest || interrupted) throw rejected();
      assertLockedDrivers();
      latest = new PrivateLease(privatePoolConfig(url, control, ca), control);
      return latest;
    },
  };
  return {
    factory,
    session(tx: object) {
      const binding = transactions.get(tx);
      if (!binding || binding.lease !== latest || !latest.checkedOut.has(binding.client))
        throw rejected();
      latest.barrier.check();
      return verifyOwnedTLS(
        binding.client,
        binding.client.connection,
        latest.config,
        latest.control.endpoint
      );
    },
    async interrupt() {
      interrupted = true;
      await latest?.cancelAndDrain();
    },
    receipt() {
      return {
        outcome: latest?.barrier.outcome ?? 'NOT_STARTED',
        localQuiescent:
          !latest ||
          (latest.closed && latest.barrier.pending.size === 0 && latest.checkedOut.size === 0),
        cleanupFailed: latest?.cleanupFailed ?? false,
      };
    },
  };
}
