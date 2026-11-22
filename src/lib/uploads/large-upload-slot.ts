import pg from 'pg';
import { runtimeDatabaseUrl } from '@/lib/db';

const SLOTS_PER_USER = 2;
let pool: pg.Pool | undefined;

// Use a separate pool: a route holding a slot still needs its ordinary tenant
// connection for storage authorization and registration.
export async function acquireLargeUploadSlot(
  userId: string
): Promise<(() => Promise<void>) | null> {
  pool ??= new pg.Pool({
    connectionString: runtimeDatabaseUrl(),
    max: 10,
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
  try {
    await client.query('BEGIN');
    // Transaction locks work across route instances and disappear on rollback
    // or connection loss. Try each slot once without waiting for another user.
    for (let slot = 0; slot < SLOTS_PER_USER; slot++) {
      const { rows } = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, $2)) AS acquired',
        [`large-upload:${userId}`, slot]
      );
      if (rows[0]?.acquired) return release;
    }
  } catch (error) {
    await release();
    throw error;
  }
  await release();
  return null;
}
