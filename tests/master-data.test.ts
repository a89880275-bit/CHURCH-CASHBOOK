import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRepository } from '../server/file-store';
import { createApi } from '../server/api';
import { issueSession } from '../server/auth';
import { ids, seed } from '../server/seed';
import { koreaDate } from '../server/policy';

const origin = 'http://127.0.0.1:5173';
let root: string, repo: FileRepository, api: ReturnType<typeof createApi>, admin: string, accountant: string;
const request = (path: string, cookie: string | undefined, data?: unknown, method = 'POST') => new Request(origin + '/api' + path, {
  method: data === undefined ? 'GET' : method,
  headers: { origin, ...(cookie ? { cookie } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
});
const user = (extra = {}) => ({ loginId: 'newperson', displayName: '신규 담당자', role: 'ACCOUNTANT', status: 'ACTIVE', reason: '담당자 등록', expectedRevision: 1, ...extra });
const department = (extra = {}) => ({ code: 'NEW', name: '신규 부서', status: 'ACTIVE', reason: '부서 등록', expectedRevision: 1, ...extra });
const account = (extra = {}) => ({ departmentId: ids.edu, code: 'I001', name: '회비 수입', type: 'INCOME', sortOrder: 10, status: 'ACTIVE', reason: '계정 등록', expectedRevision: 1, ...extra });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'accounting-api-')); repo = new FileRepository(root); await repo.initialize(seed());
  api = createApi(repo, { origin, local: true });
  admin = (await issueSession(repo, 'local:admin', true)).split(';')[0]; accountant = (await issueSession(repo, 'local:accountant', true)).split(';')[0];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('stage 1 APIs backed by real JSON files', () => {
  it('stores the department period, audits it, and preserves all ledger references when switching',async()=>{
    const original=await repo.control();
    const response=await api(request('/admin/departments',admin,department({id:ids.edu,code:'EDU',name:'교육부',managementPeriod:'YEARLY'}),'PATCH'));
    expect(response.status).toBe(200);
    const saved=await new FileRepository(root).control();expect(saved.departments[0].managementPeriod).toBe('YEARLY');
    expect(saved.transactionRefs).toEqual(original.transactionRefs);expect(saved.assignments).toEqual(original.assignments);
    expect(saved.audit[0].after).toMatchObject({managementPeriod:'YEARLY'});
    expect((await api(request('/admin/departments',admin,department({id:ids.edu,code:'EDU',name:'명칭 변경',expectedRevision:2}),'PATCH'))).status).toBe(200);
    expect((await repo.control()).departments[0].managementPeriod).toBe('YEARLY');
  });
  it('defaults existing departments to monthly and new departments to yearly; rejects unsupported modes',async()=>{
    expect((await repo.control()).departments[0].managementPeriod).toBe('MONTHLY');
    const response=await api(request('/admin/departments',admin,department()));expect((await response.json()).data.department.managementPeriod).toBe('YEARLY');
    expect((await api(request('/admin/departments',admin,department({code:'OTHER',managementPeriod:'WEEKLY',expectedRevision:2})))).status).toBe(422);
  });
  it('rechecks current assignments inside the commit boundary for an in-flight request', async () => {
    class RevokingRepository extends FileRepository {
      override async updateControl(expected: number, change: Parameters<FileRepository['updateControl']>[1]) {
        await super.updateControl(1, s => { s.assignments = s.assignments.filter(a => a.departmentId !== ids.edu); return s; });
        return super.updateControl(expected, change);
      }
    }
    const racing = createApi(new RevokingRepository(root), { origin, local: true });
    expect((await racing(request('/accounts', accountant, account({ expectedRevision: 2 })))).status).toBe(403);
    expect((await repo.control()).accounts).toHaveLength(0);
  });
  it('registers a user and audit together and persists after reopening', async () => {
    const response = await api(request('/admin/users', admin, user())); expect(response.status).toBe(201);
    const state = await new FileRepository(root).control();
    expect(state.users.find(u => u.loginId === 'newperson')?.subject).toBe('local:newperson');
    expect(state.audit[0]).toMatchObject({ actorUserId: ids.admin, action: 'USER_CREATED' });
    expect(JSON.stringify(state.audit)).not.toContain('local:');
  });
  it.each(['/admin/users', '/admin/departments'])('denies accountant writes at %s', async path => {
    expect((await api(request(path, accountant, path.endsWith('users') ? user() : department()))).status).toBe(403);
    expect((await repo.control()).revision).toBe(1);
  });
  it('rejects duplicate login IDs case insensitively', async () => { expect((await api(request('/admin/users', admin, user({ loginId: 'ADMIN' })))).status).toBe(409); });
  it('requires a verified subject for production user registration', async () => {
    const secure = (await issueSession(repo, 'local:admin')).split(';')[0];
    const production = createApi(repo, { origin });
    expect((await production(request('/admin/users', secure, user()))).status).toBe(422);
  });
  it('rejects unknown fields such as password and createdBy', async () => {
    expect((await api(request('/admin/users', admin, user({ password: 'do-not-store' })))).status).toBe(422);
    expect((await api(request('/accounts', accountant, account({ createdBy: ids.admin })))).status).toBe(422);
  });
  it('cannot disable or demote the last active administrator', async () => {
    const base = { id: ids.admin, displayName: '관리자', role: 'ADMIN', status: 'DISABLED', reason: '권한 변경', expectedRevision: 1 };
    expect((await api(request('/admin/users', admin, base, 'PATCH'))).status).toBe(409);
    expect((await api(request('/admin/users', admin, { ...base, role: 'ACCOUNTANT', status: 'ACTIVE' }, 'PATCH'))).status).toBe(409);
    expect((await repo.control()).users[0].status).toBe('ACTIVE');
  });
  it('disabling user immediately denies an existing session', async () => {
    const input = { id: ids.b, displayName: '김담당', role: 'ACCOUNTANT', status: 'DISABLED', reason: '담당자 사용 중지', expectedRevision: 1 };
    expect((await api(request('/admin/users', admin, input, 'PATCH'))).status).toBe(200);
    expect((await api(request('/me', accountant))).status).toBe(401);
  });
  it('registers and modifies departments without changing their IDs', async () => {
    const created = await (await api(request('/admin/departments', admin, department()))).json();
    const id = created.data.department.id;
    expect((await api(request('/admin/departments', admin, department({ id, name: '변경된 부서', expectedRevision: 2 }), 'PATCH'))).status).toBe(200);
    expect((await repo.control()).departments.find(d => d.id === id)?.name).toBe('변경된 부서');
  });
  it('rejects duplicate department codes', async () => { expect((await api(request('/admin/departments', admin, department({ code: 'edu' })))).status).toBe(409); });
  it('department suspension preserves records but blocks accountant access and admin writes', async () => {
    expect((await api(request('/accounts', accountant, account()))).status).toBe(201);
    expect((await api(request('/admin/departments', admin, department({ id: ids.edu, code: 'EDU', name: '교육부', status: 'INACTIVE', expectedRevision: 2 }), 'PATCH'))).status).toBe(200);
    expect((await api(request('/accounts?departmentId=' + ids.edu, accountant))).status).toBe(403);
    expect((await api(request('/accounts?departmentId=' + ids.edu, admin))).status).toBe(200);
    expect((await api(request('/accounts', admin, account({ code: 'I002', expectedRevision: 3 })))).status).toBe(409);
    expect((await repo.control()).accounts).toHaveLength(1); expect((await repo.control()).assignments).toHaveLength(2);
  });
  it('allows same account code in independent departments but denies duplicates in one', async () => {
    expect((await api(request('/accounts', accountant, account()))).status).toBe(201);
    expect((await api(request('/accounts', admin, account({ departmentId: ids.mission, expectedRevision: 2 })))).status).toBe(201);
    expect((await api(request('/accounts', accountant, account({ code: 'i001', expectedRevision: 3 })))).status).toBe(409);
    expect((await repo.control()).accounts).toHaveLength(2);
  });
  it('denies cross-department account read and write', async () => {
    expect((await api(request('/accounts?departmentId=' + ids.mission, accountant))).status).toBe(403);
    expect((await api(request('/accounts', accountant, account({ departmentId: ids.mission })))).status).toBe(403);
  });
  it('cannot patch another departments account by changing departmentId', async () => {
    const r = await (await api(request('/accounts', admin, account({ departmentId: ids.mission })))).json();
    expect((await api(request('/accounts', accountant, account({ id: r.data.account.id, expectedRevision: 2 }), 'PATCH'))).status).toBe(404);
    expect((await repo.control()).accounts[0].departmentId).toBe(ids.mission);
  });
  it('account editing and deactivation preserve ID and history; type changes are blocked', async () => {
    const created = await (await api(request('/accounts', accountant, account()))).json();
    const id = created.data.account.id;
    expect((await api(request('/accounts', accountant, account({ id, status: 'INACTIVE', name: '회비(중지)', expectedRevision: 2 }), 'PATCH'))).status).toBe(200);
    expect((await api(request('/accounts', accountant, account({ id, type: 'EXPENSE', expectedRevision: 3 }), 'PATCH'))).status).toBe(409);
    const state = await repo.control(); expect(state.accounts[0].id).toBe(id); expect(state.accounts[0].status).toBe('INACTIVE');
    expect(state.audit.map(a => a.action)).toEqual(['ACCOUNT_CREATED', 'ACCOUNT_UPDATED']);
  });
  it('simultaneous account writes conflict visibly; explicit reload/retry preserves both', async () => {
    const responses = await Promise.all([api(request('/accounts', accountant, account())), api(request('/accounts', accountant, account({ code: 'I002' })))]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    const latest = await repo.control();
    const missing = latest.accounts[0].code === 'I001' ? 'I002' : 'I001';
    expect((await api(request('/accounts', accountant, account({ code: missing, expectedRevision: latest.revision })))).status).toBe(201);
    expect((await new FileRepository(root).control()).accounts).toHaveLength(2);
  });
  it('assignment clearing keeps other departments and records the previous scope', async () => {
    const r = await api(request('/admin/assignments', admin, { departmentId: ids.edu, userIds: [], effectiveDate: koreaDate(), reason: '교육부 배정 해제', expectedRevision: 1 }));
    expect(r.status).toBe(200);
    expect((await api(request('/accounts?departmentId=' + ids.edu, accountant))).status).toBe(403);
    expect((await api(request('/accounts?departmentId=' + ids.music, accountant))).status).toBe(200);
    expect((await repo.control()).audit[0].action).toBe('ASSIGNMENT_REPLACED');
  });
  it('storage failure returns 503 and leaves data AND audit unchanged', async () => {
    const before = await readFile(join(root, 'current.json'), 'utf8');
    const broken = createApi(new FileRepository(root, { beforePublish: async () => { throw new Error('disk error'); } }), { origin, local: true });
    const r = await broken(request('/accounts', accountant, account()));
    expect(r.status).toBe(503); expect(await r.text()).not.toContain('disk error');
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(before);
    expect((await repo.control()).audit).toEqual([]);
  });
  it('local identities come from actual JSON, and disabled users disappear', async () => {
    const initial = await (await api(request('/auth/local-identities', undefined))).json(); expect(initial.data).toHaveLength(3);
    await api(request('/admin/users', admin, { id: ids.b, displayName: '김담당', role: 'ACCOUNTANT', status: 'DISABLED', reason: '사용 중지', expectedRevision: 1 }, 'PATCH'));
    const changed = await (await api(request('/auth/local-identities', undefined))).json(); expect(changed.data.some((x: { identity: string }) => x.identity === 'accountant')).toBe(false);
  });
});
