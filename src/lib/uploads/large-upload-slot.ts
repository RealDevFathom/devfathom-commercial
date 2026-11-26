import pg from 'pg';
import { runtimeDatabaseUrl } from '@/lib/db';

const SLOTS_PER_USER = 2;
const SLOTS_PER_ORGANIZATION = 4;
// A single business can hold only four of the ten connections on this server.
const POOL_SIZE = 10;
let pool: pg.Pool | undefined;

// Use a separate pool: a route holding a slot still needs its ordinary tenant
// connection for storage authorization and registration.
export async function acquireLargeUploadSlot(
  userId: string,
  organizationId: string
): Promise<(() => Promise<void>) | 'organization-capacity' | null> {
  pool ??= new pg.Pool({
    connectionString: runtimeDatabaseUrl(),
    max: POOL_SIZE,
    connectionTimeoutMillis: 2000,
  }).on('error', () => console.warn('large_upload_idle_connection_lost'));
  const client = await pool.connect();
  let disconnected = false;
  const onError = () => {
    disconnected = true;
  };
  client.on('error', onError);
  async function release() {
    try {
      if (!disconnected) await client.query('ROLLBACK');
    } catch {
      disconnected = true;
    } finally {
      client.removeListener('error', onError);
      client.release(disconnected);
    }
  }
  // Transaction locks work across route instances and disappear on rollback
  // or connection loss. Try each slot once without waiting for another upload.
  async function trySlots(key: string, count: number) {
    for (let slot = 0; slot < count; slot++) {
      const { rows } = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, $2)) AS acquired',
        [key, slot]
      );
      if (rows[0]?.acquired) return true;
    }
    return false;
  }
  try {
    await client.query('BEGIN');
    if (await trySlots(`large-upload:${userId}`, SLOTS_PER_USER)) {
      if (await trySlots(`large-upload-org:${organizationId}`, SLOTS_PER_ORGANIZATION)) {
        return release;
      }
      await release();
      return 'organization-capacity';
    }
  } catch (error) {
    await release();
    throw error;
  }
  await release();
  return null;
}
