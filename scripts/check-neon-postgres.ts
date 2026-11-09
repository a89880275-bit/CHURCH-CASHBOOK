import { Pool } from 'pg';
import { productionPoolConfig } from '../server/production-store';
import type { TLSSocket } from 'node:tls';
import { PostgresRepository } from '../server/postgres-store';
import { createApi } from '../server/api';

// Operator-only diagnostic. Only writes a temporary table, then rolls it back.
// Never prints credentials, endpoint URLs or financial row data.
let pool: Pool | undefined;
try {
  const expectedBranch = process.argv[2];
  if (!expectedBranch || process.env.NEON_BRANCH_ID !== expectedBranch) throw new Error('EXPECTED_BRANCH_REQUIRED');
  for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    const value = process.env[name]; if (!value) throw new Error('DATABASE_ENV_MISSING');
    console.log(`${name}: present; option names=${[...new URL(value).searchParams.keys()].join(',') || 'none'}`);
  }
  pool = new Pool(productionPoolConfig(process.env));
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query('SELECT 1 AS ok');
    if (result.rows[0]?.ok !== 1) throw new Error('SQL_CHECK_FAILED');
    // pg_stat_ssl behind PgBouncer describes its backend link, not our client TLS.
    const tls = (client as unknown as { connection: { stream: TLSSocket } }).connection.stream;
    if (!tls.encrypted || !tls.authorized) throw new Error('TLS_REQUIRED');
    const tables = await client.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2");
    console.log('PASS: live PostgreSQL SELECT 1 and certificate-verified TLS.');
    console.log('TABLE INVENTORY: ' + JSON.stringify(tables.rows));
    const columns = await client.query("SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='cashbook' ORDER BY table_name,ordinal_position");
    console.log('CASHBOOK COLUMNS: ' + JSON.stringify(columns.rows));
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    try {
      await client.query('CREATE TEMP TABLE cashbook_connection_probe (id integer PRIMARY KEY,payload json NOT NULL) ON COMMIT DROP');
      await client.query('INSERT INTO cashbook_connection_probe VALUES ($1,$2::json)', [1, JSON.stringify({ amount: 123, purpose: 'temporary connection check' })]);
      await client.query('UPDATE cashbook_connection_probe SET payload=$1::json WHERE id=1', [JSON.stringify({ amount: 456, purpose: 'temporary connection check' })]);
      const probe = await client.query('SELECT payload FROM cashbook_connection_probe WHERE id=1');
      if (probe.rows[0]?.payload.amount !== 456) throw new Error('JSON_ROUNDTRIP_FAILED');
    } finally { await client.query('ROLLBACK'); }
    const removed = await client.query("SELECT to_regclass('pg_temp.cashbook_connection_probe') AS table_name");
    if (removed.rows[0]?.table_name !== null) throw new Error('PROBE_ROLLBACK_FAILED');
    console.log('PASS: live JSON insert/update/read and transaction rollback; temporary table removed.');
  } finally { client.release(); }
  const repo = new PostgresRepository(pool);
  try { await repo.control(); console.log('PASS: application adapter read the current control JSON.'); }
  catch (error) { if ((error as { code?: string }).code === 'NOT_PROVISIONED') console.log('PENDING: initial application administrator; empty store was not seeded.'); else throw error; }
  const api = createApi(repo, { origin: 'https://connection-check.invalid' });
  const anonymous = await api(new Request('https://connection-check.invalid/api/me'));
  if (anonymous.status !== 401) throw new Error('AUTH_BOUNDARY_CHECK_FAILED');
  console.log('PASS: application API denies anonymous access (401); no temporary login bypass.');
} catch (error) {
  let detail = (error as Error).message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted URL]');
  for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    try { const url = new URL(process.env[key]!); for (const value of [url.href, url.hostname, decodeURIComponent(url.username), decodeURIComponent(url.password)]) if (value) detail = detail.replaceAll(value, '[redacted]'); } catch {}
  }
  console.error('DETAIL: ' + detail);
  console.error('CHECK FAILED: ' + ((error as { code?: string }).code ?? ((error as Error).message === 'DATABASE_CONFIG_INVALID' ? 'DATABASE_CONFIG_INVALID' : 'CONNECTION_OR_BRANCH_CHECK_FAILED')));
  process.exitCode = 1;
} finally { await pool?.end(); }
