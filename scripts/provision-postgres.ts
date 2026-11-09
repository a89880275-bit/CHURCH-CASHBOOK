import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { productionPoolConfig } from '../server/production-store';
import { PostgresRepository } from '../server/postgres-store';
import { validateProductionInitial } from '../server/provisioning';

// Operator-only command. Never called by Netlify build or public API.
const [command, file, confirmation] = process.argv.slice(2);
let pool: Pool | undefined;
try {
  if (confirmation !== '--apply' || !file || !['schema', 'initialize'].includes(command)) throw new Error('usage');
  pool = new Pool(productionPoolConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL }));
  if (command === 'schema') {
    const schema = await readFile(new URL('../server/postgres-schema.sql', import.meta.url), 'utf8');
    // Require the exact checked-in migration path; never run arbitrary user SQL files.
    if (file !== 'cashbook-v1') throw new Error('migration');
    await pool.query(schema); console.log('APPLIED: cashbook v1 schema; no seed accounts or financial data inserted.');
  } else {
    const initial = validateProductionInitial(JSON.parse(await readFile(file, 'utf8')));
    await new PostgresRepository(pool).initialize(initial);
    console.log('INITIALIZED: private initial administrator. Existing control JSON was not overwritten.');
  }
} catch {
  console.error('NOT_COMPLETED: check TLS-verified DATABASE_URL, database permissions and command/input. No credentials or provider errors are printed.');
  process.exitCode = 1;
} finally { await pool?.end(); }
