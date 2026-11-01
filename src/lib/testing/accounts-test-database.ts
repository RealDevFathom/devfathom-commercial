import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

/** Test-only: no client imports, connections, environment fallback or fixture writes. */
export type AccountsTestDatabase = Readonly<{
  url: string;
  database: string;
  role: string;
  socket: string;
  runId: string;
}>;

function refuse(): never {
  // Never include a URL/parser exception (which may contain credentials).
  throw new Error('ACCOUNTS_TEST_REQUIRES_FRESH_PRIVATE_SOCKET_DATABASE');
}

export function accountsTestDatabase(env: NodeJS.ProcessEnv): AccountsTestDatabase {
  try {
    const url = env.M8_TEST_RUNTIME_DATABASE_URL ?? env.TEST_DATABASE_URL;
    const runId = env.PHARMACY_ACCOUNTS_TEST_RUN_ID;
    const database = env.PHARMACY_ACCOUNTS_TEST_DATABASE;
    const role = env.PHARMACY_ACCOUNTS_TEST_ROLE;
    const socket = env.PHARMACY_ACCOUNTS_TEST_SOCKET;
    if (
      !url ||
      /\s/.test(url) ||
      !runId ||
      !/^[a-f0-9]{32}$/.test(runId) ||
      !database ||
      database !== `qa603_${runId}` ||
      !role ||
      !/^qa603_[a-z0-9_]+$/.test(role) ||
      !socket ||
      !isAbsolute(socket) ||
      normalize(socket) !== socket ||
      /[\x00-\x20,%]/.test(socket)
    )
      refuse();
    // WHATWG URLs require an authority when username is present. Its fixed
    // placeholder localhost is NEVER the target: the sole mandatory host
    // query is an absolute private Unix socket, validated below.
    const parsed = new URL(url);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      parsed.hostname !== 'localhost' ||
      parsed.hash ||
      parsed.port ||
      decodeURIComponent(parsed.pathname) !== `/${database}` ||
      decodeURIComponent(parsed.username) !== role
    )
      refuse();
    // node-postgres takes the LAST repeated query value; never validate a first
    // host then hand the driver a second remote host/database/user/options.
    const entries = [...parsed.searchParams.entries()];
    if (entries.length !== 1 || entries[0][0] !== 'host' || entries[0][1] !== socket) refuse();
    const directory = lstatSync(socket);
    if (
      realpathSync(socket) !== socket ||
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700 ||
      !lstatSync(`${socket}/.s.PGSQL.5432`).isSocket()
    )
      refuse();
    // pg falls back to ambient PGPORT when the URL omits its port. Pin the
    // exact socket suffix verified above, including if PGPORT changes after
    // this preflight. Callers pass this URL through the real runtime boundary.
    parsed.port = '5432';
    return Object.freeze({ url: parsed.href, database, role, socket, runId });
  } catch {
    return refuse();
  }
}

type ReadOnlyDb = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

/** Must run before ALL fixture writes, in addition to role + FORCE-RLS guards.
 * The new-DB harness creates this single-row identity table as its owner and
 * grants runtime SELECT only. Its unguessable run id is not an application key.
 */
export async function assertAccountsTestDatabase(
  withPlatformDb: <T>(fn: (db: ReadOnlyDb) => Promise<T>) => Promise<T>,
  expected: AccountsTestDatabase
): Promise<void> {
  const identity = await withPlatformDb((db) =>
    db.$queryRawUnsafe<
      {
        database: string;
        role: string;
        local: boolean;
        runId: string;
      }[]
    >(`SELECT current_database() AS database, current_user AS role,
      inet_server_addr() IS NULL AS local, run_id AS "runId"
      FROM public._qa603_disposable_identity`)
  );
  if (
    !Array.isArray(identity) ||
    identity.length !== 1 ||
    identity[0].database !== expected.database ||
    identity[0].role !== expected.role ||
    identity[0].local !== true ||
    identity[0].runId !== expected.runId
  )
    throw new Error('ACCOUNTS_TEST_ACTUAL_TARGET_MISMATCH');
}
