import { Pool, type PoolConfig } from 'pg';
import { BlobsRepository, type Repository } from './store';
import { PostgresRepository } from './postgres-store';

export function productionPoolConfig(env: NodeJS.ProcessEnv): PoolConfig {
  // Do not let sslmode URL parameters silently override certificate validation.
  try {
    const url = new URL(env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2) throw new Error();
    for (const key of [...url.searchParams.keys()]) {
      if (key !== 'sslmode' || !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get(key)!)) throw new Error();
      url.searchParams.delete(key);
    }
    return { connectionString: url.href, ssl: { rejectUnauthorized: true, ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT } : {}) }, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 8000, idle_in_transaction_session_timeout: 15000, application_name: 'church-cashbook' };
  } catch { throw new Error('DATABASE_CONFIG_INVALID'); }
}

let pool: Pool | undefined;
export function productionRepository(env: NodeJS.ProcessEnv = process.env): Repository {
  const driver = env.STORAGE_DRIVER ?? 'blobs';
  if (driver === 'blobs') {
    if (!env.BLOBS_STORE) throw new Error('BLOBS_NOT_CONFIGURED');
    return new BlobsRepository(env.BLOBS_STORE);
  }
  if (driver !== 'postgres') throw new Error('STORAGE_DRIVER_INVALID');
  if (!pool) {
    pool = new Pool(productionPoolConfig(env));
    // Never log connection strings, credentials, SQL contents or financial JSON.
    pool.on('error', () => console.error('DATABASE_IDLE_CONNECTION_FAILED'));
  }
  return new PostgresRepository(pool, { writable: env.ACCOUNTING_WRITES_ENABLED === 'true' });
}
