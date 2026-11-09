import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestPostgres } from './fixtures/postgres-engine';
import { Pool } from 'pg';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgresRepository } from '../server/postgres-store';
import { productionPoolConfig } from '../server/production-store';
import { productionInitialControl, validateProductionInitial } from '../server/provisioning';
import { seed, ids } from '../server/seed';
import { createApi } from '../server/api';
import { issueSession } from '../server/auth';
import { financeBackup } from '../server/backups';

const origin = 'https://cashbook-test.example', account = '00000000-0000-4000-8000-000000000031';
let cluster: Awaited<ReturnType<typeof startTestPostgres>>, pool: Pool, second: Pool, repo: PostgresRepository, peer: PostgresRepository;
let api: ReturnType<typeof createApi>, peerApi: ReturnType<typeof createApi>, admin: string, staff: string;
async function freePort() { const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const port = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return port; }
function req(path: string, cookie = admin, body?: unknown, method = 'POST') { return new Request(origin + '/api' + path, { method: body === undefined ? 'GET' : method, headers: { cookie, origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
function create(amount = 100, requestId = randomUUID()) { return { departmentId: ids.edu, requestId, date: '2026-05-10', type: 'INCOME', accountId: account, description: '격리 PostgreSQL 검증', amount, remark: '' }; }
async function close(period = '2026-05', operation = 'CLOSE', revision?: number) { return api(req('/admin/closings', admin, { departmentId: ids.edu, kind: period.length === 4 ? 'YEAR' : 'MONTH', period, operation, reason: '격리 마감 검증', expectedRevision: revision ?? (await repo.control()).revision })); }
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'cashbook-postgres-')), port = await freePort(), password = randomBytes(24).toString('hex');
  cluster = await startTestPostgres(root, port, password);
  // Real isolated loopback engine; never consumes an externally configured DATABASE_URL.
  const config = { host: '127.0.0.1', port, user: 'cashbook_test', password, database: 'postgres', max: 3, connectionTimeoutMillis: 5000 };
  pool = new Pool(config); second = new Pool(config);
  await pool.query(await readFile(new URL('../server/postgres-schema.sql', import.meta.url), 'utf8'));
}, 60000);
afterAll(async () => { await pool?.end(); await second?.end(); await cluster?.stop(); }, 30000);
beforeEach(async () => {
  await pool.query('TRUNCATE cashbook.control,cashbook.transactions,cashbook.snapshots,cashbook.sessions,cashbook.backups');
  repo = new PostgresRepository(pool, { writable: true }); peer = new PostgresRepository(second, { writable: true });
  const state = seed(); for (const u of state.users) u.subject = u.subject.replace('local:', 'oidc-test:');
  state.accounts = [{ id: account, departmentId: ids.edu, code: 'I001', name: '검증 회비', type: 'INCOME', status: 'ACTIVE', sortOrder: 1 }];
  state.openingBalances = [{ id: randomUUID(), departmentId: ids.edu, date: '2026-01-01', amount: 1000, createdBy: ids.admin, updatedBy: ids.admin, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  await repo.initialize(state); api = createApi(repo, { origin }); peerApi = createApi(peer, { origin });
  admin = (await issueSession(repo, 'oidc-test:admin')).split(';')[0]; staff = (await issueSession(repo, 'oidc-test:accountant')).split(';')[0];
});
describe('real PostgreSQL storage and production-mode APIs', () => {
  it('serializes staff initial opening balances across two connections and reserves amendments for admin',async()=>{
    await repo.commitLedger(s=>{s.openingBalances=[];return s;});
    const body={departmentId:ids.edu,date:'2026-01-01',amount:0,reason:'최초 잔액 동시 검수',expectedRevision:(await repo.control()).revision};
    const responses=await Promise.all([api(req('/opening-balances',staff,body)),peerApi(req('/opening-balances',staff,{...body,amount:100}))]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,403]);
    const saved=await repo.control();expect(saved.openingBalances).toHaveLength(1);expect(saved.audit).toHaveLength(1);
    expect((await peerApi(req('/opening-balances',staff,{...body,amount:200,expectedRevision:saved.revision}))).status).toBe(403);
    expect(await repo.control()).toEqual(saved);
    expect((await api(req('/opening-balances',admin,{...body,amount:300,expectedRevision:saved.revision}))).status).toBe(200);
    expect((await peer.control()).openingBalances[0]).toMatchObject({amount:300,createdBy:ids.b,updatedBy:ids.admin});
  });
  it('serializes catalog imports across independent SQL pools and preserves transaction references',async()=>{
    const sources=[];
    for(const name of ['표준 A','표준 B']){
      const response=await api(req('/admin/standard-accounts',admin,{code:name==='표준 A'?'STD-A':'STD-B',name,type:'INCOME',majorCategory:'수입',minorCategory:'검수',status:'ACTIVE',sortOrder:1,expectedRevision:(await repo.control()).revision,reason:'독립 SQL 검수'}));
      expect(response.status).toBe(201);sources.push((await response.json()).data.account.id);
    }
    const before=await repo.control(),revision=before.revision;
    const body=(id:string,expectedRevision:number)=>({departmentId:ids.edu,standardAccountIds:[id],expectedRevision,requestId:randomUUID(),reason:'부서 가져오기 검수'});
    const responses=await Promise.all([api(req('/accounts/import',staff,body(sources[0],revision))),peerApi(req('/accounts/import',staff,body(sources[1],revision)))]);
    expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
    const current=await repo.control(),remaining=sources.find(id=>!current.accounts.some(a=>a.standardAccountId===id))!;
    expect((await api(req('/accounts/import',staff,body(remaining,current.revision)))).status).toBe(201);
    const after=await peer.control(),copies=after.accounts.filter(a=>a.standardAccountId);
    expect(new Set(copies.map(a=>a.code)).size).toBe(2);expect(after.transactionRefs).toEqual(before.transactionRefs);expect(after.accounts.find(a=>a.id===account)).toEqual(before.accounts.find(a=>a.id===account));
  });
  it('does not overwrite provisioning or enable business writes by default', async () => {
    await expect(repo.initialize(seed())).rejects.toMatchObject({ code: 'ALREADY_PROVISIONED' });
    const readonly = new PostgresRepository(pool); expect(readonly.writable).toBe(false);
    await expect(readonly.commitLedger(s => s)).rejects.toMatchObject({ code: 'WRITE_NOT_VERIFIED' });
    await expect(repo.putTransaction({} as never)).rejects.toMatchObject({ code: 'TRANSACTION_REQUIRED' });
  });
  it('commits create/edit/delete JSON and matching audit/snapshot records', async () => {
    const response = await api(req('/transactions', staff, create(200))); expect(response.status).toBe(201);
    const tx = (await response.json()).data.transaction;
    expect((await api(req('/transactions', staff, { ...create(250), requestId: undefined, id: tx.id, expectedVersion: 1, reason: '수정 검증' }, 'PATCH'))).status).toBe(200);
    expect((await api(req('/transactions', staff, { id: tx.id, departmentId: ids.edu, expectedVersion: 2, reason: '삭제 검증' }, 'DELETE'))).status).toBe(200);
    const state = await peer.control(); expect(state.revision).toBe(4); expect(state.audit.map(a => a.action)).toEqual(['TRANSACTION_CREATED', 'TRANSACTION_UPDATED', 'TRANSACTION_DELETED']);
    expect((await peer.readTransaction(state.transactionRefs[0])).status).toBe('DELETED');
    for (const table of ['transactions', 'snapshots']) expect(Number((await pool.query(`SELECT count(*) FROM cashbook.${table}`)).rows[0].count)).toBe(3);
  });
  it('retains twelve concurrent creates across independent pools', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? api : peerApi)(req('/transactions', staff, create(i + 1)))));
    expect(results.map(r => r.status)).toEqual(Array(12).fill(201));
    const state = await repo.control(); expect(state.transactionRefs).toHaveLength(12); expect(state.audit).toHaveLength(12); expect(state.revision).toBe(13);
    expect((await Promise.all(state.transactionRefs.map(r => repo.readTransaction(r)))).reduce((n, t) => n + t.amount, 0)).toBe(78);
  });
  it('deduplicates simultaneous request retries and rejects conflicting edits', async () => {
    const input = create(), results = await Promise.all([api(req('/transactions', staff, input)), peerApi(req('/transactions', staff, input))]);
    expect(results.every(r => r.status === 200 || r.status === 201)).toBe(true);
    let state = await repo.control(); expect(state.transactionRefs).toHaveLength(1); expect(state.audit).toHaveLength(1);
    const tx = await repo.readTransaction(state.transactionRefs[0]), edit = { ...create(300), requestId: undefined, id: tx.id, expectedVersion: 1, reason: '경쟁 수정' };
    const edits = await Promise.all([api(req('/transactions', staff, edit, 'PATCH')), peerApi(req('/transactions', staff, { ...edit, amount: 400 }, 'PATCH'))]);
    expect(edits.map(r => r.status).sort()).toEqual([200, 409]); state = await repo.control(); expect(state.audit).toHaveLength(2);
  });
  it('rolls back inserted objects and control JSON after callback failure', async () => {
    await api(req('/transactions', staff, create())); const old = await repo.control(), tx = await repo.readTransaction(old.transactionRefs[0]);
    await expect(repo.commitLedger(async s => { await repo.putTransaction({ ...tx, id: randomUUID() }); s.accounts[0].name = '게시 금지'; throw new Error('injected failure'); })).rejects.toMatchObject({ code: 'STORAGE_COMMIT_UNCONFIRMED' });
    expect(await repo.control()).toEqual(old); expect(Number((await pool.query('SELECT count(*) FROM cashbook.transactions')).rows[0].count)).toBe(1);
  });
  it('rolls back inserts, audit and snapshots when database publication fails', async () => {
    await pool.query("CREATE FUNCTION cashbook.fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER fail_publish BEFORE UPDATE ON cashbook.control FOR EACH ROW EXECUTE FUNCTION cashbook.fail_publish()");
    try { expect((await api(req('/transactions', staff, create()))).status).toBe(503); expect((await repo.control()).revision).toBe(1); for (const table of ['transactions', 'snapshots']) expect(Number((await pool.query(`SELECT count(*) FROM cashbook.${table}`)).rows[0].count)).toBe(0); }
    finally { await pool.query('DROP TRIGGER fail_publish ON cashbook.control; DROP FUNCTION cashbook.fail_publish()'); }
  });
  it('fails closed on corrupt/missing transaction JSON', async () => {
    await api(req('/transactions', staff, create())); const state = await repo.control(), ref = state.transactionRefs[0];
    await pool.query("UPDATE cashbook.transactions SET payload=json_build_object('id',id)");
    await expect(repo.readTransaction(ref)).rejects.toMatchObject({ code: 'TRANSACTION_INVALID' });
    expect((await api(req('/reports/monthly?year=2026&departmentId=' + ids.edu, staff))).status).toBe(503);
    await expect(repo.commitLedger(s => { s.transactionRefs.push({ ...ref, id: randomUUID() }); return s; })).rejects.toMatchObject({ code: 'TRANSACTION_INVALID' });
    expect((await repo.control()).revision).toBe(state.revision);
  });
  it('enforces department privacy and revokes existing-session access', async () => {
    expect((await api(req('/reports/monthly?year=2026&departmentId=' + ids.mission, staff))).status).toBe(403);
    expect((await api(req('/transactions', staff, { ...create(), departmentId: ids.mission }))).status).toBe(403);
    await peer.commitLedger(s => { s.assignments = []; return s; });
    expect((await api(req('/transactions', staff, create()))).status).toBe(403); expect((await repo.control()).transactionRefs).toHaveLength(0);
  });
  it('rechecks permission after waiting for another connection to revoke it', async () => {
    let unlock!: () => void, locked!: () => void; const ready = new Promise<void>(r => locked = r), wait = new Promise<void>(r => unlock = r);
    const revoke = peer.commitLedger(async s => { locked(); await wait; s.assignments = []; return s; }); await ready;
    const pending = api(req('/transactions', staff, create())); let observed = false;
    try { for (let i = 0; i < 100; i++) { const rows = await second.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%cashbook.control%' AND pid<>pg_backend_pid()"); if (rows.rowCount) { observed = true; break; } await new Promise(r => setTimeout(r, 10)); } }
    finally { unlock(); }
    await revoke; expect(observed).toBe(true); expect((await pending).status).toBe(403); expect((await repo.control()).transactionRefs).toHaveLength(0);
  });
  it('serializes competing closes, blocks new entries and permits explicit reopening', async () => {
    await api(req('/transactions', staff, create())); const revision = (await repo.control()).revision;
    const results = await Promise.all([close('2026-05', 'CLOSE', revision), peerApi(req('/admin/closings', admin, { departmentId: ids.edu, kind: 'MONTH', period: '2026-05', operation: 'CLOSE', reason: '경쟁 마감', expectedRevision: revision }))]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]); expect((await api(req('/transactions', staff, create()))).status).toBe(409);
    expect((await close('2026-05', 'REOPEN')).status).toBe(200); expect((await api(req('/transactions', staff, create()))).status).toBe(201);
  });
  it('enforces annual closing prerequisites and reopening order', async () => {
    expect((await close('2026')).status).toBe(409);
    for (let m = 1; m <= 12; m++) expect((await close(`2026-${String(m).padStart(2, '0')}`)).status).toBe(200);
    expect((await close('2026')).status).toBe(200); expect((await close('2026-05', 'REOPEN')).status).toBe(409);
    expect((await close('2026', 'REOPEN')).status).toBe(200); expect((await close('2026-05', 'REOPEN')).status).toBe(200);
  });
  it('previews and restores financial JSON with a separately committed pre-restore copy', async () => {
    await api(req('/transactions', staff, create(200))); const archive = await financeBackup(repo, await repo.control());
    await api(req('/transactions', staff, create(300))); const revision = (await repo.control()).revision;
    expect((await api(req('/admin/backups/preview', admin, { backup: archive, expectedRevision: revision }))).status).toBe(200);
    const r = await api(req('/admin/backups/restore', admin, { backup: archive, expectedRevision: revision, checksum: archive.checksum, confirmation: 'RESTORE', reason: '격리 복원 검증' }));
    expect(r.status).toBe(200); expect((await repo.control()).transactionRefs).toHaveLength(1);
    expect(JSON.parse((await pool.query('SELECT contents FROM cashbook.backups')).rows[0].contents).payload.transactions).toHaveLength(2);
    expect((await repo.control()).audit.at(-1)?.action).toBe('STORAGE_RESTORED'); expect((await peer.control()).assignments).toHaveLength(2);
  });
  it('keeps the recovery copy but rolls back failed restore publication', async () => {
    await api(req('/transactions', staff, create())); const archive = await financeBackup(repo, await repo.control());
    await api(req('/transactions', staff, create())); const current = await repo.control();
    await pool.query("CREATE FUNCTION cashbook.fail_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER fail_restore BEFORE UPDATE ON cashbook.control FOR EACH ROW EXECUTE FUNCTION cashbook.fail_restore()");
    try { expect((await api(req('/admin/backups/restore', admin, { backup: archive, expectedRevision: current.revision, checksum: archive.checksum, confirmation: 'RESTORE', reason: '실패 검증' }))).status).toBe(503); expect(await repo.control()).toEqual(current); expect(Number((await pool.query('SELECT count(*) FROM cashbook.backups')).rows[0].count)).toBe(1); }
    finally { await pool.query('DROP TRIGGER fail_restore ON cashbook.control; DROP FUNCTION cashbook.fail_restore()'); }
  });
  it('persists sessions across instances and revokes them on logout', async () => {
    expect((await peerApi(req('/me', staff))).status).toBe(200); expect((await api(req('/auth/logout', staff, {}))).status).toBe(200);
    expect((await peerApi(req('/me', staff))).status).toBe(401); await pool.query("UPDATE cashbook.sessions SET payload='{}'::json"); expect((await api(req('/me', admin))).status).toBe(503);
  });
  it('runs create and restore with the documented restricted runtime role', async () => {
    await pool.query(`CREATE ROLE cashbook_runtime_test NOLOGIN;
      GRANT USAGE ON SCHEMA cashbook TO cashbook_runtime_test;
      GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA cashbook TO cashbook_runtime_test;
      GRANT UPDATE ON cashbook.control,cashbook.sessions TO cashbook_runtime_test;
      GRANT DELETE ON cashbook.sessions TO cashbook_runtime_test`);
    // pg keeps password non-enumerable; explicitly pass the ephemeral test value.
    const runtimePool = new Pool({ ...pool.options, password: pool.options.password, options: '-c role=cashbook_runtime_test', max: 3 });
    try {
      const runtimeRepo = new PostgresRepository(runtimePool, { writable: true }), runtimeApi = createApi(runtimeRepo, { origin });
      expect((await runtimeApi(req('/transactions', staff, create()))).status).toBe(201);
      const archive = await financeBackup(runtimeRepo, await runtimeRepo.control());
      expect((await runtimeApi(req('/transactions', staff, create()))).status).toBe(201);
      const current = await runtimeRepo.control();
      expect((await runtimeApi(req('/admin/backups/restore', admin, { backup: archive, expectedRevision: current.revision, checksum: archive.checksum, confirmation: 'RESTORE', reason: '제한 역할 복원 검증' }))).status).toBe(200);
      expect((await runtimeRepo.control()).transactionRefs).toHaveLength(1);
      await expect(runtimePool.query('UPDATE cashbook.transactions SET payload=payload')).rejects.toMatchObject({ code: '42501' });
      await expect(runtimePool.query('DELETE FROM cashbook.control')).rejects.toMatchObject({ code: '42501' });
    } finally { await runtimePool.end(); }
  });
});
describe('production provisioning and TLS', () => {
  it('creates only one real-subject administrator and rejects local seed accounts', () => {
    const state = productionInitialControl({ subject: 'auth0|provider-id', loginId: 'church.admin', displayName: '회계 관리자' });
    expect(validateProductionInitial(state)).toEqual(state); expect(state.users).toHaveLength(1); expect(state.transactionRefs).toEqual([]);
    expect(() => productionInitialControl({ subject: 'local:owner', loginId: 'owner', displayName: '로컬' })).toThrow(); expect(() => validateProductionInitial(seed())).toThrow();
  });
  it('requires certificate validation and rejects URL parameters overriding TLS', () => {
    const config = productionPoolConfig({ DATABASE_URL: 'postgresql://runtime:non-live-password@db.example/cashbook?sslmode=require&channel_binding=require' });
    expect(config.ssl).toEqual({ rejectUnauthorized: true }); expect(config.connectionString).not.toContain('sslmode'); expect(config.max).toBeGreaterThanOrEqual(2);
    expect(config.enableChannelBinding).toBe(true); expect(config.connectionString).not.toContain('channel_binding');
    for (const url of ['', 'http://db.example/', 'postgres://user:password@db.example/cashbook?sslmode=disable', 'postgres://user:password@db.example/cashbook?sslcert=untrusted']) expect(() => productionPoolConfig({ DATABASE_URL: url })).toThrow('DATABASE_CONFIG_INVALID');
  });
});
