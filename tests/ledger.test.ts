import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileRepository } from '../server/file-store';
import { createApi } from '../server/api';
import { issueSession } from '../server/auth';
import { seed, ids } from '../server/seed';
import type { Control, Transaction } from '../server/schema';
import { koreaDate } from '../server/policy';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { MemoryRepository } from '../server/store';
import { unzip } from './xlsx-utils';

const origin = 'http://127.0.0.1:5173';
const incomeId = '00000000-0000-4000-8000-000000000031', expenseId = '00000000-0000-4000-8000-000000000032', missionId = '00000000-0000-4000-8000-000000000033';
let root: string, repo: FileRepository, api: ReturnType<typeof createApi>, admin: string, b: string, c: string;
function request(path: string, cookie?: string, body?: unknown, method = 'POST') {
  return new Request(origin + '/api' + path, { method: body === undefined ? 'GET' : method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const input = (extra = {}) => ({ requestId: randomUUID(), departmentId: ids.edu, date: '2026-05-20', accountId: incomeId, type: 'INCOME', description: '회비 납부', amount: 100000, remark: '', ...extra });
async function create(extra = {}, cookie = b) { const body = input(extra), response = await api(request('/transactions', cookie, body)); expect(response.status).toBe(201); return (await response.json()).data.transaction as Transaction; }
async function listing(extra = '', cookie = b) { const response = await api(request('/transactions?departmentId=' + ids.edu + extra, cookie)); expect(response.status).toBe(200); return (await response.json()).data; }
function update(tx: Transaction, extra = {}) { return { id: tx.id, departmentId: tx.departmentId, date: tx.date, accountId: tx.accountId, type: tx.type, description: tx.description, amount: tx.amount, remark: tx.remark, expectedVersion: tx.version, reason: '거래 내용 정정', ...extra }; }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'accounting-ledger-')); repo = new FileRepository(root);
  const state = seed(); state.accounts = [
    { id: incomeId, departmentId: ids.edu, code: 'I001', name: '회비', type: 'INCOME', sortOrder: 10, status: 'ACTIVE' },
    { id: expenseId, departmentId: ids.edu, code: 'E001', name: '교재', type: 'EXPENSE', sortOrder: 20, status: 'ACTIVE' },
    { id: missionId, departmentId: ids.mission, code: 'I001', name: '회비', type: 'INCOME', sortOrder: 10, status: 'ACTIVE' },
  ];
  await repo.initialize(state); api = createApi(repo, { origin, local: true });
  [admin,b,c] = await Promise.all(['local:admin','local:accountant','local:successor'].map(async subject => (await issueSession(repo, subject, true)).split(';')[0]));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('ledger API backed by immutable per-transaction JSON', () => {
  it('prints all matching rows beyond pagination with filtered totals and department balances',async()=>{
    await api(request('/opening-balances',b,{departmentId:ids.edu,date:'2026-01-01',amount:1000,reason:'출력 잔액 검수',expectedRevision:1}));
    await create({description:'출력 첫째',amount:100});await create({description:'출력 둘째',amount:200});await create({description:'검색 제외',amount:500});
    const before=await repo.control(),response=await api(request('/transactions/print?departmentId='+ids.edu+'&from=2026-05-01&to=2026-05-31&keyword=출력&pageSize=1&page=2',b));
    expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/html');expect(response.headers.get('cache-control')).toBe('no-store');
    const html=await response.text();expect(html).toContain('출력 첫째');expect(html).toContain('출력 둘째');expect(html).not.toContain('검색 제외');expect(html).toContain('검색 결과 전체 2건');expect(html).toContain('수입 합계: 300');expect(html).toContain('기간말 누적잔액: 1,800');expect(await repo.control()).toEqual(before);
  });
  it('escapes user entered descriptions and remarks in printable HTML',async()=>{
    await create({description:'<script>alert(1)</script>',remark:'<img src=x onerror=alert(1)>'});
    const response=await api(request('/transactions/print?departmentId='+ids.edu,b)),html=await response.text();
    expect(response.status).toBe(200);expect(html).toContain('&lt;script&gt;');expect(html).toContain('&lt;img');expect(html).not.toContain('<script>');expect(html).not.toContain('<img');
  });
  it('denies anonymous and cross-department printing without modifying data',async()=>{
    const before=await repo.control();expect((await api(request('/transactions/print?departmentId='+ids.edu))).status).toBe(401);
    expect((await api(request('/transactions/print?departmentId='+ids.mission,b))).status).toBe(403);expect(await repo.control()).toEqual(before);
  });
  it('shows period carry as initial balance plus prior activity, excluding first-day activity', async () => {
    await api(request('/admin/opening-balances',admin,{departmentId:ids.edu,date:'2026-01-01',amount:500000,reason:'이월 검증',expectedRevision:1}));
    await create({date:'2026-05-31',amount:100000});
    await create({date:'2026-05-31',type:'EXPENSE',accountId:expenseId,amount:20000});
    await create({date:'2026-06-01',amount:30000});
    const result=await listing('&from=2026-06-01&to=2026-06-30');
    expect(result.carryForward).toBe(580000);expect(result.balance).toBe(610000);
    expect(result.carryForward+result.totals.difference).toBe(result.balance);
  });
  it('yearly carry includes the previous year exactly once and respects custom search boundaries',async()=>{
    await api(request('/admin/opening-balances',admin,{departmentId:ids.edu,date:'2025-01-01',amount:1000,reason:'전년도 잔액',expectedRevision:1}));
    await create({date:'2025-12-31',amount:2000});await create({date:'2026-01-01',amount:3000});
    const result=await listing('&from=2026-01-01&to=2026-12-31&keyword=없음');
    expect(result.carryForward).toBe(3000);expect(result.totals.income).toBe(0);expect(result.balance).toBe(6000);
    const summary=await(await api(request('/reports/summary?departmentId='+ids.edu+'&from=2026-01-01&to=2026-12-31',b))).json();
    expect(summary.data).toMatchObject({carryForward:3000,income:3000,expense:0,balance:6000});
  });
  it('preserves null for unknown carry and allows explicit zero and negative carry',async()=>{
    expect((await listing('&from=2026-01-01')).carryForward).toBeNull();
    await api(request('/admin/opening-balances',admin,{departmentId:ids.edu,date:'2026-01-01',amount:0,reason:'0원 이월 확인',expectedRevision:1}));
    expect((await listing('&from=2026-01-01')).carryForward).toBe(0);
    await create({date:'2026-01-20',type:'EXPENSE',accountId:expenseId,amount:100});
    expect((await listing('&from=2026-02-01')).carryForward).toBe(-100);
  });
  it('does not invent carry for a range beginning before the opening effective date',async()=>{
    await api(request('/admin/opening-balances',admin,{departmentId:ids.edu,date:'2026-06-01',amount:1000,reason:'중간 도입 잔액',expectedRevision:1}));
    const result=await listing('&from=2026-01-01&to=2026-12-31');expect(result.carryForward).toBeNull();expect(result.balance).toBe(1000);
  });
  it('deleted prior transactions do not contribute to the carry',async()=>{
    await api(request('/admin/opening-balances',admin,{departmentId:ids.edu,date:'2026-01-01',amount:1000,reason:'이월 검증',expectedRevision:1}));
    const tx=await create({date:'2026-01-20',amount:500});
    await api(request('/transactions',b,{id:tx.id,departmentId:ids.edu,expectedVersion:1,reason:'중복 취소'},'DELETE'));
    expect((await listing('&from=2026-02-01&includeDeleted=1')).carryForward).toBe(1000);
  });
  it('dashboard summary denies other departments and accountant access to the global scope',async()=>{
    expect((await api(request('/reports/summary?from=2026-01-01&to=2026-12-31',b))).status).toBe(403);
    expect((await api(request('/reports/summary?departmentId='+ids.mission+'&from=2026-01-01&to=2026-12-31',b))).status).toBe(403);
    expect((await api(request('/reports/summary?departmentId='+ids.edu+'&from=2026-01-01&to=2026-12-31'))).status).toBe(401);
  });
  it('global dashboard never reports a partial known balance as a complete balance',async()=>{
    await api(request('/admin/opening-balances',admin,{departmentId:ids.edu,date:'2026-01-01',amount:1000,reason:'이월 검증',expectedRevision:1}));await create();
    const response=await api(request('/reports/summary?from=2026-01-01&to=2026-12-31',admin));
    expect((await response.json()).data).toMatchObject({income:100000,carryForward:null,balance:null,missingCarry:['찬양부','선교부']});
  });
  it('reads and upgrades an existing control snapshot with no ledger fields without replacing its master records', async () => {
    const old = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
    delete old.payload.transactionRefs; delete old.payload.openingBalances; delete old.payload.closings;
    old.checksum = createHash('sha256').update(JSON.stringify(old.payload)).digest('hex');
    await writeFile(join(root, 'current.json'), JSON.stringify(old));
    expect((await repo.control()).transactionRefs).toEqual([]);
    await create();
    expect((await repo.control()).users.map(u => u.id)).toEqual([ids.admin,ids.b,ids.c]);
    expect((await listing()).total).toBe(1);
  });
  it('does not pretend unsupported storage adapters can read or write ledger objects', async () => {
    const memory = new MemoryRepository(seed());
    const cookie = (await issueSession(memory,'local:admin',true)).split(';')[0];
    const unsupported = createApi(memory,{origin,local:true});
    expect((await unsupported(request('/transactions?departmentId='+ids.edu,cookie))).status).toBe(503);
    expect((await unsupported(request('/transactions',cookie,input()))).status).toBe(503);
    expect((await memory.control()).transactionRefs).toHaveLength(0);
  });
  it('retains both creates from two independent Node API processes', async () => {
    const run = promisify(execFile);
    const results = await Promise.all([1,2].map(() => run(process.execPath, ['--import','tsx','tests/fixtures/ledger-writer.ts',root])));
    expect(results.map(r => r.stdout)).toEqual(['COMMITTED','COMMITTED']);
    expect((await listing()).totals.income).toBe(246); expect((await listing()).total).toBe(2);
  }, 15000);
  it('closing introduced before acquiring the business lock rejects the write', async () => {
    class Closing extends FileRepository { override async commitLedger(change: (s: Control) => Control | Promise<Control>) { await this.updateControl(1, s => { s.closings.push({ id: randomUUID(), departmentId: ids.edu, period: '2026-05', status: 'CLOSED' }); return s; }); return super.commitLedger(change); } }
    const response = await createApi(new Closing(root), { origin, local: true })(request('/transactions', admin, input()));
    expect(response.status).toBe(409); expect((await repo.control()).transactionRefs).toHaveLength(0);
  });
  it('a new date in a closed month cannot receive an existing open-month transaction', async () => {
    const tx = await create();
    await repo.updateControl(2, s => { s.closings.push({ id: randomUUID(), departmentId: ids.edu, period: '2026-06', status: 'CLOSED' }); return s; });
    expect((await api(request('/transactions', admin, update(tx, { date: '2026-06-01' }), 'PATCH'))).status).toBe(409);
    expect((await listing()).items[0].date).toBe('2026-05-20');
  });
  it('requires authentication and rejects an unassigned department', async () => {
    expect((await api(request('/transactions?departmentId=' + ids.edu))).status).toBe(401);
    expect((await api(request('/transactions?departmentId=' + ids.mission, b))).status).toBe(403);
    expect((await api(request('/transactions', c, input()))).status).toBe(403);
  });
  it('registers a transaction, manifest and audit; survives reopening', async () => {
    const tx = await create(); const state = await new FileRepository(root).control();
    expect(state.transactionRefs).toHaveLength(1); expect(state.audit[0].action).toBe('TRANSACTION_CREATED');
    expect(await new FileRepository(root).readTransaction(state.transactionRefs[0])).toEqual(tx);
    expect(tx.createdBy).toBe(ids.b); expect(tx.departmentId).toBe(ids.edu); expect(tx.version).toBe(1);
  });
  it('validates department-specific accounts and income/expense types', async () => {
    expect((await api(request('/transactions', b, input({ accountId: missionId })))).status).toBe(422);
    expect((await api(request('/transactions', b, input({ accountId: expenseId })))).status).toBe(422);
    expect((await api(request('/transactions?departmentId=' + ids.edu + '&accountId=' + missionId, b))).status).toBe(403);
  });
  it('rejects inactive accounts and inactive departments even for admins', async () => {
    await repo.updateControl(1, s => { s.accounts[0].status = 'INACTIVE'; return s; });
    expect((await api(request('/transactions', admin, input()))).status).toBe(422);
    await repo.updateControl(2, s => { s.departments[0].status = 'INACTIVE'; return s; });
    expect((await api(request('/transactions', admin, input()))).status).toBe(409);
  });
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid amount %s', async amount => { expect((await api(request('/transactions', b, input({ amount })))).status).toBe(422); });
  it('rejects forged authors and immutable owner fields', async () => {
    expect((await api(request('/transactions', b, input({ createdBy: ids.admin })))).status).toBe(422);
    const tx = await create(); expect((await api(request('/transactions', b, update(tx, { createdAt: tx.createdAt }), 'PATCH'))).status).toBe(422);
  });
  it('updates with version check and preserves original author/time/department', async () => {
    const tx = await create(); const r = await api(request('/transactions', admin, update(tx, { description: '관리자 정정' }), 'PATCH')); expect(r.status).toBe(200);
    const changed = (await r.json()).data.transaction;
    expect(changed).toMatchObject({ id: tx.id, departmentId: tx.departmentId, createdBy: ids.b, createdAt: tx.createdAt, updatedBy: ids.admin, version: 2 });
    const history = await (await api(request('/transactions/history?departmentId=' + ids.edu + '&id=' + tx.id, b))).json();
    expect(history.data.map((a: { action: string }) => a.action)).toEqual(['TRANSACTION_CREATED','TRANSACTION_UPDATED']);
    expect(history.data[1].before.description).toBe('회비 납부');
  });
  it('soft deletion requires reason, keeps old object and excludes amount from totals', async () => {
    const tx = await create(); const oldRef = (await repo.control()).transactionRefs[0];
    expect((await api(request('/transactions', b, { id: tx.id, departmentId: ids.edu, expectedVersion: 1, reason: '' }, 'DELETE'))).status).toBe(422);
    expect((await api(request('/transactions', b, { id: tx.id, departmentId: ids.edu, expectedVersion: 1, reason: '중복 입력 취소' }, 'DELETE'))).status).toBe(200);
    expect((await listing()).totals.income).toBe(0); expect((await listing()).items).toHaveLength(0);
    const deleted = (await listing('&includeDeleted=1')).items[0]; expect(deleted.status).toBe('DELETED'); expect(deleted.deletionReason).toBe('중복 입력 취소');
    expect((await repo.readTransaction(oldRef)).status).toBe('ACTIVE');
  });
  it('searches dates/type/account/description and paginates without changing overall filtered totals', async () => {
    await create(); await create({ date: '2026-06-01', description: '6월 회비', amount: 200000 });
    await create({ accountId: expenseId, type: 'EXPENSE', amount: 30000, description: '교재 구입' });
    expect((await listing('&from=2026-05-01&to=2026-05-31')).totals).toMatchObject({ income: 100000, expense: 30000, difference: 70000 });
    expect((await listing('&keyword=교재')).total).toBe(1);
    expect((await listing('&type=INCOME&pageSize=1&page=2')).items).toHaveLength(1);
    expect((await listing('&type=INCOME&pageSize=1&page=2')).totals.income).toBe(300000);
    expect((await api(request('/transactions?departmentId=' + ids.edu + '&from=2026-06-01&to=2026-05-01', b))).status).toBe(422);
  });
  it('reports balance as unset instead of zero until administrator explicitly sets opening balance', async () => {
    await create(); expect((await listing()).balance).toBeNull(); expect((await listing()).openingBalance).toBeNull();
  });
  it('allows assigned staff initial zero balance once; only admin can amend it, preserving identity and audit',async()=>{
    const body={departmentId:ids.edu,date:'2026-01-01',amount:0,reason:'최초 잔액 확인',expectedRevision:1};
    expect((await api(request('/opening-balances',b,body))).status).toBe(200);
    const before=await repo.control();expect(before.openingBalances[0].createdBy).toBe(ids.b);expect(before.audit[0]).toMatchObject({actorUserId:ids.b,action:'OPENING_BALANCE_SET',before:null});
    expect((await api(request('/opening-balances',b,{...body,amount:10,expectedRevision:2}))).status).toBe(403);
    expect(await repo.control()).toEqual(before);
    expect((await api(request('/opening-balances',admin,{...body,amount:20,expectedRevision:2}))).status).toBe(200);
    const after=await repo.control();expect(after.openingBalances[0]).toMatchObject({id:before.openingBalances[0].id,createdBy:ids.b,updatedBy:ids.admin,amount:20});expect(after.audit).toHaveLength(2);
  });
  it('denies unassigned and disabled staff initial balances without changes',async()=>{
    const body={departmentId:ids.mission,date:'2026-01-01',amount:1,reason:'권한 검증',expectedRevision:1};const before=await repo.control();
    expect((await api(request('/opening-balances',b,body))).status).toBe(403);
    expect((await api(request('/opening-balances',c,{...body,departmentId:ids.edu}))).status).toBe(403);
    expect(await repo.control()).toEqual(before);
    await repo.updateControl(1,s=>{s.users.find(u=>u.id===ids.b)!.status='DISABLED';return s;});
    expect((await api(request('/opening-balances',b,{...body,departmentId:ids.edu,expectedRevision:2}))).status).toBe(401);
    expect((await repo.control()).openingBalances).toHaveLength(0);
  });
  it('serializes simultaneous initial balances so only one staff request succeeds',async()=>{
    const body={departmentId:ids.edu,date:'2026-01-01',amount:100,reason:'동시 최초 등록',expectedRevision:1};
    const results=await Promise.all([api(request('/opening-balances',b,body)),api(request('/opening-balances',b,{...body,amount:200}))]);
    expect(results.map(r=>r.status).sort()).toEqual([200,403]);const saved=await repo.control();expect(saved.openingBalances).toHaveLength(1);expect(saved.audit).toHaveLength(1);expect([100,200]).toContain(saved.openingBalances[0].amount);
  });
  it('rechecks staff assignment inside the opening balance commit',async()=>{
    class RevokingRepository extends FileRepository {
      override async commitLedger(change:Parameters<FileRepository['commitLedger']>[0]){
        await super.commitLedger(s=>{s.assignments=s.assignments.filter(a=>a.departmentId!==ids.edu);return s;});
        return super.commitLedger(change);
      }
    }
    const racing=createApi(new RevokingRepository(root),{origin,local:true});
    expect((await racing(request('/opening-balances',b,{departmentId:ids.edu,date:'2026-01-01',amount:100,reason:'배정 해제 경합',expectedRevision:2}))).status).toBe(403);
    expect((await repo.control()).openingBalances).toHaveLength(0);
  });
  it('admin sets opening balance; includes prior activity once and ignores search filters in period-end balance', async () => {
    const opening = { departmentId: ids.edu, date: '2026-01-01', amount: 500000, reason: '검증된 이월 잔액 입력', expectedRevision: 1 };
    expect((await api(request('/admin/opening-balances', b, opening))).status).toBe(403);
    expect((await api(request('/admin/opening-balances', admin, opening))).status).toBe(200);
    await create(); await create({ type: 'EXPENSE', accountId: expenseId, amount: 30000, date: '2026-06-10' });
    const filtered = await listing('&from=2026-06-01&to=2026-06-30&keyword=없음');
    expect(filtered.total).toBe(0); expect(filtered.balance).toBe(570000);
    expect((await listing('&to=2025-12-31')).balance).toBeNull();
    expect((await api(request('/transactions', b, input({ date: '2025-12-31' })))).status).toBe(422);
  });
  it('explicit zero opening balance is allowed, late opening date cannot hide earlier transactions', async () => {
    await create();
    expect((await api(request('/admin/opening-balances', admin, { departmentId: ids.edu, date: '2026-06-01', amount: 0, expectedRevision: 2, reason: '기초잔액 설정' }))).status).toBe(422);
    expect((await api(request('/admin/opening-balances', admin, { departmentId: ids.edu, date: '2026-01-01', amount: 0, expectedRevision: 2, reason: '기초잔액 설정' }))).status).toBe(200);
    expect((await listing()).balance).toBe(100000);
  });
  it('different simultaneous transactions both commit without a global stale-revision rejection', async () => {
    const r = await Promise.all([api(request('/transactions', b, input())), api(request('/transactions', b, input({ amount: 200000 })))]);
    expect(r.map(x => x.status)).toEqual([201,201]); expect((await listing()).totals.income).toBe(300000);
    expect((await repo.control()).audit).toHaveLength(2);
  });
  it('same transaction simultaneous edits produce one success/one conflict', async () => {
    const tx = await create();
    const r = await Promise.all([api(request('/transactions', b, update(tx, { amount: 200000 }), 'PATCH')), api(request('/transactions', admin, update(tx, { amount: 300000 }), 'PATCH'))]);
    expect(r.map(x => x.status).sort()).toEqual([200,409]);
    expect((await listing()).items[0].version).toBe(2); expect((await repo.control()).audit).toHaveLength(2);
  });
  it('create retry with the same request ID does not duplicate a saved transaction', async () => {
    const body = input(); expect((await api(request('/transactions', b, body))).status).toBe(201);
    expect((await api(request('/transactions', b, body))).status).toBe(200);
    expect((await api(request('/transactions', b, { ...body, amount: 1 }))).status).toBe(409);
    expect((await listing()).total).toBe(1); expect((await repo.control()).audit).toHaveLength(1);
  });
  it('cross-department transaction IDs cannot be edited/deleted/read through history', async () => {
    const tx = await create({ departmentId: ids.mission, accountId: missionId }, admin);
    expect((await api(request('/transactions', b, update(tx), 'PATCH'))).status).toBe(403);
    expect((await api(request('/transactions', b, update(tx, { departmentId: ids.edu, accountId: incomeId }), 'PATCH'))).status).toBe(404);
    expect((await api(request('/transactions/history?departmentId=' + ids.mission + '&id=' + tx.id, b))).status).toBe(403);
  });
  it('handover changes only permissions; successor sees historical transaction and original author', async () => {
    const tx = await create(), oldRef = (await repo.control()).transactionRefs[0];
    expect((await api(request('/admin/assignments', admin, { departmentId: ids.edu, userIds: [ids.c], effectiveDate: koreaDate(), expectedRevision: 2, reason: '담당자 인수인계' }))).status).toBe(200);
    expect((await api(request('/transactions?departmentId=' + ids.edu, b))).status).toBe(403);
    expect((await listing('', c)).items[0].createdBy).toBe(ids.b);
    expect((await repo.control()).transactionRefs[0]).toEqual(oldRef); expect(await repo.readTransaction(oldRef)).toEqual(tx);
    expect((await api(request('/transactions?departmentId=' + ids.music, b))).status).toBe(200);
  });
  it('closed month blocks create/update/delete even for admins and guards old and new dates', async () => {
    const tx = await create();
    await repo.updateControl(2, s => { s.closings.push({ id: randomUUID(), departmentId: ids.edu, period: '2026-05', status: 'CLOSED' }); return s; });
    expect((await api(request('/transactions', admin, input()))).status).toBe(409);
    expect((await api(request('/transactions', admin, update(tx, { date: '2026-06-01' }), 'PATCH'))).status).toBe(409);
    expect((await api(request('/transactions', admin, { id: tx.id, departmentId: ids.edu, expectedVersion: 1, reason: '취소 요청' }, 'DELETE'))).status).toBe(409);
    expect((await api(request('/admin/opening-balances', admin, { departmentId: ids.edu, date: '2026-01-01', amount: 0, reason: '잔액 정정', expectedRevision: 3 }))).status).toBe(409);
  });
  it('rechecks account status inside the shared commit lock', async () => {
    class Inactivating extends FileRepository { override async commitLedger(change: (s: Control) => Control | Promise<Control>) { await this.updateControl(1, s => { s.accounts[0].status = 'INACTIVE'; return s; }); return super.commitLedger(change); } }
    const racing = createApi(new Inactivating(root), { origin, local: true });
    expect((await racing(request('/transactions', b, input()))).status).toBe(422);
    expect((await listing()).total).toBe(0); expect((await repo.control()).audit).toHaveLength(0);
  });
  it('rechecks revocation and closings when they precede business lock acquisition', async () => {
    class Revoking extends FileRepository { override async commitLedger(change: (s: Control) => Control | Promise<Control>) { await this.updateControl(1, s => { s.assignments = s.assignments.filter(a => a.departmentId !== ids.edu); return s; }); return super.commitLedger(change); } }
    expect((await createApi(new Revoking(root), { origin, local: true })(request('/transactions', b, input()))).status).toBe(403);
    expect((await repo.control()).transactionRefs).toHaveLength(0);
    await repo.updateControl(2, s => { s.closings.push({ id: randomUUID(), departmentId: ids.edu, period: '2026-05', status: 'CLOSED' }); return s; });
    expect((await api(request('/transactions', admin, input()))).status).toBe(409);
  });
  it('object-write failure or manifest-publish failure never exposes a partial transaction', async () => {
    const initial = await readFile(join(root, 'current.json'), 'utf8');
    class BrokenObject extends FileRepository { override async putTransaction(): Promise<never> { throw new Error('object disk failure'); } }
    expect((await createApi(new BrokenObject(root), { origin, local: true })(request('/transactions', b, input()))).status).toBe(503);
    const failing = new FileRepository(root, { beforePublish: async () => { throw new Error('manifest publish failure'); } });
    expect((await createApi(failing, { origin, local: true })(request('/transactions', b, input()))).status).toBe(503);
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(initial);
    expect((await listing()).total).toBe(0); expect((await repo.control()).audit).toHaveLength(0);
  });
  it('modification publish failure leaves the previous committed transaction and audit untouched', async () => {
    const tx = await create(); const before = await repo.control();
    const broken = createApi(new FileRepository(root, { beforePublish: async () => { throw new Error('failed'); } }), { origin, local: true });
    expect((await broken(request('/transactions', b, update(tx, { amount: 500 }), 'PATCH'))).status).toBe(503);
    expect(await repo.control()).toEqual(before); expect((await listing()).items[0].amount).toBe(100000);
  });
  it('tampered transaction JSON fails closed instead of silently omitting it', async () => {
    await create(); const ref = (await repo.control()).transactionRefs[0];
    await writeFile(join(root, 'transactions', ref.departmentId, ref.id, `${ref.version}-${ref.hash}.json`), '{}');
    expect((await api(request('/transactions?departmentId=' + ids.edu, b))).status).toBe(503);
  });
  it('rejects total overflow before the manifest or audit commits', async () => {
    await create({ amount: Number.MAX_SAFE_INTEGER });
    expect((await api(request('/transactions', b, input({ amount: 1 })))).status).toBe(422);
    expect((await listing()).total).toBe(1); expect((await repo.control()).audit).toHaveLength(1);
  });
});


describe('diary running balances and Excel export',()=>{
  it('computes each balance from all department activity despite filters, sort and pagination',async()=>{
    await api(request('/admin/opening-balances',admin,{departmentId:ids.edu,date:'2026-01-01',amount:1000,reason:'검증한 이월',expectedRevision:1}));
    await create({date:'2026-04-01',amount:100});await create({date:'2026-05-01',amount:50});
    const expense=await create({date:'2026-05-02',type:'EXPENSE',accountId:expenseId,amount:20});
    const result=await listing('&from=2026-05-01&to=2026-05-31&type=EXPENSE&pageSize=1&sort=date_desc');
    expect(result.items[0].id).toBe(expense.id);expect(result.items[0].runningBalance).toBe(1130);expect(result.totals.expense).toBe(20);expect(result.carryForward).toBe(1100);
  });
  it('keeps per-transaction balances unknown without an opening balance and excludes deleted transactions',async()=>{
    const first=await create();expect((await listing()).items[0].runningBalance).toBeNull();
    await api(request('/transactions',b,{id:first.id,departmentId:ids.edu,expectedVersion:first.version,reason:'중복 기록 취소'},'DELETE'));
    expect((await listing('&includeDeleted=1')).items[0].runningBalance).toBeNull();
  });
  it('exports all matching rows beyond pagination from the same authorized snapshot without modifying it',async()=>{
    await create({description:'=SUM(A1) <교회>',date:'2026-05-01',amount:100});await create({description:'두 번째 기록',date:'2026-05-02',amount:50});await create({date:'2026-06-01',description:'기간 밖'});
    const before=await repo.control();const response=await api(request('/transactions/export.xlsx?departmentId='+ids.edu+'&from=2026-05-01&to=2026-05-31&pageSize=1',b));
    expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('spreadsheetml');
    const sheet=unzip(Buffer.from(await response.arrayBuffer()))['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('=SUM(A1) &lt;교회&gt;');expect(sheet).toContain('두 번째 기록');expect(sheet).not.toContain('기간 밖');expect(sheet).not.toContain('<f>');expect(await repo.control()).toEqual(before);
  });
  it('requires authentication and current department access for export',async()=>{
    const path='/transactions/export.xlsx?departmentId='+ids.mission;
    expect((await api(request(path))).status).toBe(401);expect((await api(request(path,b))).status).toBe(403);expect((await api(request(path,admin))).status).toBe(200);
  });
});
