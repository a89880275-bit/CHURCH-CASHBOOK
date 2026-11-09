import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { productionPoolConfig } from '../server/production-store';
import { PostgresRepository } from '../server/postgres-store';
import { controlSchema, type Transaction } from '../server/schema';
import { financeBackup, handleBackups } from '../server/backups';
import { TEST_APP_ORIGIN, TEST_NEON_BRANCH } from '../server/auth0-setup';

// Test harness only: production SQL is unchanged. Route its fixed cashbook table
// prefix into a newly-created, random verification schema on this TEST branch.
function scoped(pool: Pool, schema: string): Pool {
  const query = (db: { query: Function }, sql: string, values?: unknown[]) => db.query(sql.replaceAll('cashbook.', `${schema}.`), values);
  return { query: (sql: string, values?: unknown[]) => query(pool, sql, values), connect: async () => {
    const client = await pool.connect();
    return { query: (sql: string, values?: unknown[]) => query(client, sql, values), release: (error?: boolean) => client.release(error) };
  } } as unknown as Pool;
}
const schema = 'cashbook_verify_' + randomBytes(8).toString('hex');
let owner: Pool | undefined, first: Pool | undefined, second: Pool | undefined, created = false;
const passed: string[] = [];
try {
  const link = JSON.parse(await readFile('.neon', 'utf8'));
  if (link.projectId !== 'withered-flower-37879263' || process.env.NEON_BRANCH_ID !== TEST_NEON_BRANCH || process.env.APP_ORIGIN !== TEST_APP_ORIGIN || process.env.ACCOUNTING_WRITES_ENABLED !== 'false' || new URL(process.env.DATABASE_URL!).username !== 'cashbook_runtime') throw Error('TEST_TARGET_REQUIRED');
  owner = new Pool(productionPoolConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL_UNPOOLED }));
  const originalRepo = new PostgresRepository(owner), original = await originalRepo.control();
  const approval = JSON.parse(await readFile('.private/deployment/admin-approval-plan.json', 'utf8'));
  const admin = original.users.find(u => u.id === approval.user.id && u.subject === approval.user.subject && u.role === 'ADMIN' && u.status === 'ACTIVE');
  if (!admin || original.departments.length || original.transactionRefs.length) throw Error('EXPECTED_INITIAL_TEST_STATE_REQUIRED');
  if (!/^cashbook_verify_[a-f0-9]{16}$/.test(schema)) throw Error('UNSAFE_SCHEMA');
  if ((await owner.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount) throw Error('SCHEMA_ALREADY_EXISTS');
  const migration = (await readFile('server/postgres-schema.sql', 'utf8')).replaceAll('cashbook', schema).replace(`CREATE SCHEMA IF NOT EXISTS ${schema}`, `CREATE SCHEMA ${schema}`);
  await owner.query(migration); created = true;
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO cashbook_runtime;
    GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA ${schema} TO cashbook_runtime;
    GRANT UPDATE ON ${schema}.control,${schema}.sessions TO cashbook_runtime;
    GRANT DELETE ON ${schema}.sessions TO cashbook_runtime`);
  first = new Pool(productionPoolConfig(process.env)); second = new Pool(productionPoolConfig(process.env));
  const repo = new PostgresRepository(scoped(first, schema), { writable: true }), peer = new PostgresRepository(scoped(second, schema), { writable: true });
  const departmentId = randomUUID(), accountId = randomUUID(), now = new Date().toISOString();
  const state = controlSchema.parse({ ...original, revision: 1, audit: [], departments: [{ id: departmentId, code: 'QA', name: '격리 검증 부서', status: 'ACTIVE', createdAt: now, managementPeriod: 'YEARLY' }], assignments: [], accounts: [{ id: accountId, departmentId, code: 'QA-I', name: '검증 수입', type: 'INCOME', sortOrder: 1, status: 'ACTIVE' }], transactionRefs: [], openingBalances: [{ id: randomUUID(), departmentId, date: '2026-01-01', amount: 1000, createdBy: admin.id, updatedBy: admin.id, createdAt: now, updatedAt: now }], closings: [], annualClosings: [] });
  await repo.initialize(state);
  const transaction = (amount: number): Transaction => ({ id: randomUUID(), departmentId, accountId, date: '2026-05-10', type: 'INCOME', amount, description: '격리 원격 검증', remark: '', version: 1, status: 'ACTIVE', createdBy: admin.id, updatedBy: admin.id, createdAt: now, updatedAt: now });
  async function add(store: PostgresRepository, amount: number) {
    const tx = transaction(amount);
    await store.commitLedger(async current => {
      current.transactionRefs.push(await store.putTransaction(tx));
      current.audit.push({ id: randomUUID(), actorUserId: admin!.id, departmentId, action: 'TRANSACTION_CREATED', entityType: 'TRANSACTION', entityId: tx.id, occurredAt: now, reason: '격리 원격 검증', before: null, after: tx });
      return current;
    });
  }
  await Promise.all(Array.from({ length: 12 }, (_, i) => add(i % 2 ? repo : peer, i + 1)));
  let committed = await repo.control();
  const rows = await repo.readTransactions(committed.transactionRefs);
  if (committed.revision !== 13 || rows.length !== 12 || committed.audit.length !== 12 || rows.reduce((n, t) => n + t.amount, 0) !== 78) throw Error('CONCURRENT_WRITE_LOSS');
  passed.push('12 concurrent writes across independent Neon pooled connections; no lost transactions or audit');
  const conflicts = await Promise.allSettled([repo.updateControl(13, s => { s.accounts[0].name = '동시 A'; return s; }), peer.updateControl(13, s => { s.accounts[0].name = '동시 B'; return s; })]);
  if (conflicts.filter(r => r.status === 'fulfilled').length !== 1 || conflicts.filter(r => r.status === 'rejected' && r.reason.code === 'VERSION_CONFLICT').length !== 1) throw Error('REVISION_CONFLICT_NOT_ENFORCED');
  passed.push('one stale-revision update rejected with VERSION_CONFLICT');
  committed = await repo.control(); const rowCount = (await owner.query(`SELECT count(*)::int AS n FROM ${schema}.transactions`)).rows[0].n;
  try { await repo.commitLedger(async s => { await repo.putTransaction(transaction(999)); throw Error('injected failure'); }); throw Error('ROLLBACK_NOT_ENFORCED'); }
  catch (error) { if ((error as { code?: string }).code !== 'STORAGE_COMMIT_UNCONFIRMED') throw error; }
  if (JSON.stringify(await repo.control()) !== JSON.stringify(committed) || (await owner.query(`SELECT count(*)::int AS n FROM ${schema}.transactions`)).rows[0].n !== rowCount) throw Error('ROLLBACK_CHANGED_DATA');
  passed.push('failed transaction rolls back both immutable object and manifest');
  const backup = await financeBackup(repo, await repo.control()); await add(repo, 500); const beforeRestore = await repo.control();
  const invoke = (path: string, body: unknown) => handleBackups({ path, method: 'POST', url: new URL('https://isolated-validation.invalid' + path), state: beforeRestore, user: admin, repo, body: async () => body });
  if ((await invoke('/api/admin/backups/preview', { backup, expectedRevision: beforeRestore.revision }))?.status !== 200) throw Error('RESTORE_PREVIEW_FAILED');
  if ((await invoke('/api/admin/backups/restore', { backup, expectedRevision: beforeRestore.revision, checksum: backup.checksum, confirmation: 'RESTORE', reason: '격리 원격 복원 검증' }))?.status !== 200) throw Error('RESTORE_FAILED');
  const restored = await repo.control();
  const recovery = (await owner.query(`SELECT contents FROM ${schema}.backups`)).rows;
  if (restored.transactionRefs.length !== 12 || restored.audit.at(-1)?.action !== 'STORAGE_RESTORED' || recovery.length !== 1 || JSON.parse(recovery[0].contents).payload.transactions.length !== 13) throw Error('RESTORE_INTEGRITY_FAILED');
  passed.push('JSON preview/restore and separately committed pre-restore copy verified');
  if (JSON.stringify(await originalRepo.control()) !== JSON.stringify(original)) throw Error('ORIGINAL_TEST_DATA_CHANGED');
  passed.push('original test administrator, departments, assignments and accounting JSON unchanged');
  const record = { result: 'PASS', branchId: TEST_NEON_BRANCH, site: TEST_APP_ORIGIN, completedAt: new Date().toISOString(), passed, harness: 'actual production repository and backup code in isolated temporary schema; no deployed auth bypass or test sessions' };
  await writeFile('.private/deployment/neon-write-verification.json', JSON.stringify(record, null, 2), { mode: 0o600, flush: true });
  for (const line of passed) console.log('PASS: ' + line);
} catch (error) {
  console.error('REMOTE_VERIFICATION_STOPPED: ' + ((error as { code?: string }).code ?? (/^[A-Z_]+$/.test((error as Error).message) ? (error as Error).message : 'REDACTED'))); process.exitCode = 1;
} finally {
  await first?.end(); await second?.end();
  if (owner && created && /^cashbook_verify_[a-f0-9]{16}$/.test(schema)) {
    // Only the brand-new random schema created by this process; never cashbook.
    await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    console.log('CLEANED: only the isolated verification schema and its temporary records removed.');
  }
  await owner?.end();
}
