import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { productionPoolConfig } from '../server/production-store';
import { PostgresRepository } from '../server/postgres-store';
import { TEST_APP_ORIGIN, TEST_NEON_BRANCH } from '../server/auth0-setup';

let owner: Pool | undefined, runtime: Pool | undefined;
const privatePath = '.private/deployment/neon-runtime.env', temp = `.env.local.${randomUUID()}.tmp`;
try {
  const link = JSON.parse(await readFile('.neon', 'utf8'));
  if (link.projectId !== 'withered-flower-37879263' || process.env.NEON_BRANCH_ID !== TEST_NEON_BRANCH || process.env.APP_ORIGIN !== TEST_APP_ORIGIN || process.env.ACCOUNTING_WRITES_ENABLED !== 'false') throw new Error('TEST_TARGET_REQUIRED');
  const source = await readFile('.env.local', 'utf8'), env = parseEnv(source);
  if (!env.DATABASE_URL_UNPOOLED) throw new Error('SETUP_CONNECTION_REQUIRED');
  owner = new Pool(productionPoolConfig({ ...process.env, DATABASE_URL: env.DATABASE_URL_UNPOOLED }));
  const before = await new PostgresRepository(owner).control();
  const approval = JSON.parse(await readFile('.private/deployment/admin-approval-plan.json', 'utf8'));
  if (approval.status !== 'APPLIED_AFTER_EXPLICIT_USER_APPROVAL' || before.users.length !== 1 || before.users[0].id !== approval.user.id || before.users[0].subject !== approval.user.subject || before.users[0].role !== 'ADMIN') throw new Error('APPROVED_ADMIN_REQUIRED');
  const existing = (await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1', ['cashbook_runtime'])).rowCount;
  let appURL: string;
  try { appURL = parseEnv(await readFile(privatePath, 'utf8')).DATABASE_URL; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existing) throw new Error('EXISTING_ROLE_REQUIRES_REVIEW');
    const url = new URL(env.DATABASE_URL); url.username = 'cashbook_runtime'; url.password = randomBytes(32).toString('hex'); appURL = url.href;
    await writeFile(privatePath, `DATABASE_URL=${JSON.stringify(appURL)}\n`, { flag: 'wx', mode: 0o600, flush: true });
  }
  const app = new URL(appURL), direct = new URL(env.DATABASE_URL_UNPOOLED), original = new URL(env.DATABASE_URL);
  if (app.username !== 'cashbook_runtime' || app.hostname !== original.hostname || app.pathname !== original.pathname || !/^[a-f0-9]{64}$/.test(decodeURIComponent(app.password))) throw new Error('RUNTIME_TARGET_MISMATCH');
  if (!existing) {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      // Password consists only of 64 random hex characters, never printed.
      await client.query(`CREATE ROLE cashbook_runtime LOGIN NOINHERIT PASSWORD '${decodeURIComponent(app.password)}'`);
      await client.query('GRANT USAGE ON SCHEMA cashbook TO cashbook_runtime');
      await client.query('GRANT SELECT, INSERT ON cashbook.control,cashbook.transactions,cashbook.snapshots,cashbook.sessions,cashbook.backups TO cashbook_runtime');
      await client.query('GRANT UPDATE ON cashbook.control,cashbook.sessions TO cashbook_runtime');
      await client.query('GRANT DELETE ON cashbook.sessions TO cashbook_runtime');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  direct.username = app.username; direct.password = app.password;
  runtime = new Pool(productionPoolConfig({ ...process.env, DATABASE_URL: direct.href }));
  const flags = (await runtime.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (Object.values(flags).some(Boolean) || (await runtime.query("SELECT pg_has_role(current_user,'neon_superuser','MEMBER') AS member")).rows[0]?.member) throw new Error('RUNTIME_ROLE_TOO_PRIVILEGED');
  const after = await new PostgresRepository(runtime).control();
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('CONTROL_CHANGED');
  for (const sql of ['UPDATE cashbook.transactions SET payload=payload', 'DELETE FROM cashbook.control']) {
    const client = await runtime.connect(); let denied = false;
    try { await client.query('BEGIN'); try { await client.query(sql); } catch (error) { denied = (error as { code?: string }).code === '42501'; } }
    finally { await client.query('ROLLBACK'); client.release(); }
    if (!denied) throw new Error('RUNTIME_PERMISSION_BOUNDARY_FAILED');
  }
  const merged = source.split(/\r?\n/).filter(line => !/^\s*DATABASE_URL\s*=/.test(line)).join('\n').trimEnd() + `\nDATABASE_URL=${JSON.stringify(appURL)}\n`;
  if (parseEnv(merged).DATABASE_URL_UNPOOLED !== env.DATABASE_URL_UNPOOLED) throw new Error('SETUP_CONNECTION_CHANGED');
  await writeFile(`.private/deployment/env-before-runtime-${randomUUID()}.env`, source, { flag: 'wx', mode: 0o600, flush: true });
  await writeFile(temp, merged, { flag: 'wx', mode: 0o600, flush: true }); await rename(temp, '.env.local');
  console.log('PASS: restricted test runtime DB role connected; no admin capabilities; immutable transaction UPDATE and control DELETE denied.');
  console.log('PASS: approved administrator and all accounting JSON unchanged; pooled app URL updated privately; owner setup URL retained only locally.');
} catch (error) {
  console.error('RUNTIME_SETUP_STOPPED: ' + ((error as { code?: string }).code ?? (/^[A-Z_]+$/.test((error as Error).message) ? (error as Error).message : 'REDACTED')));
  process.exitCode = 1;
} finally { await owner?.end(); await runtime?.end(); await rm(temp, { force: true }); }
