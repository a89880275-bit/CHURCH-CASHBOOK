import { randomUUID } from 'node:crypto';
import {
  accountCreateInput, accountUpdateInput, departmentCreateInput, departmentUpdateInput,
  userCreateInput, userUpdateInput, type Control, type User,
} from './schema';
import { requireAdmin, requireDepartment } from './policy';
import { ApiError, type Repository } from './store';

const json = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
const publicUser = ({ subject, ...user }: User) => user;
const code = (value: string) => value.normalize('NFKC').toUpperCase();
function actor(state: Control, subject: string) {
  const user = state.users.find(u => u.subject === subject && u.status === 'ACTIVE');
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  return user;
}
function activeDepartment(state: Control, user: User, departmentId: string) {
  requireDepartment(state, user, departmentId);
  if (!state.departments.some(d => d.id === departmentId && d.status === 'ACTIVE')) throw new ApiError(409, 'DEPARTMENT_INACTIVE', '사용 중지된 부서는 변경할 수 없습니다.');
}
function audit(state: Control, user: User, entityType: 'USER' | 'DEPARTMENT' | 'ACCOUNT', entityId: string, departmentId: string | null, action: Control['audit'][number]['action'], before: unknown, after: unknown, reason: string) {
  state.audit.push({ id: randomUUID(), actorUserId: user.id, entityType, entityId, departmentId, action, before, after, reason, occurredAt: new Date().toISOString() });
}
export async function handleMasterData(args: {
  path: string; method: string; url: URL; state: Control; user: User;
  repo: Repository; local: boolean; body: () => Promise<unknown>;
}): Promise<Response | null> {
  const { path, method, url, state, user, repo } = args;
  if (path === '/api/admin/master' && method === 'GET') {
    requireAdmin(user);
    return json({ revision: state.revision, users: state.users.map(publicUser), departments: state.departments, assignments: state.assignments });
  }
  if (path === '/api/admin/departments' && method === 'GET') {
    requireAdmin(user); return json({ departments: state.departments, revision: state.revision });
  }
  if (path === '/api/admin/users' && ['POST', 'PATCH'].includes(method)) {
    requireAdmin(user);
    if (method === 'POST') {
      const input = userCreateInput.parse(await args.body());
      const subject = args.local ? `local:${input.loginId.toLowerCase()}` : input.subject;
      if (!subject || (!args.local && subject.startsWith('local:'))) throw new ApiError(422, 'SUBJECT_REQUIRED', '인증 제공자의 사용자 식별자(sub)가 필요합니다.');
      const created: User = { id: randomUUID(), subject, loginId: input.loginId.toLowerCase(), displayName: input.displayName, role: input.role, status: input.status, createdAt: new Date().toISOString() };
      const next = await repo.updateControl(input.expectedRevision, current => {
        const admin = actor(current, user.subject); requireAdmin(admin);
        if (current.users.some(u => u.loginId.toLowerCase() === created.loginId || u.subject === subject)) throw new ApiError(409, 'USER_DUPLICATE', '이미 등록된 아이디 또는 인증 사용자입니다.');
        current.users.push(created);
        audit(current, admin, 'USER', created.id, null, 'USER_CREATED', null, publicUser(created), input.reason);
        return current;
      });
      return json({ user: publicUser(created), revision: next.revision }, 201);
    }
    const input = userUpdateInput.parse(await args.body());
    const next = await repo.updateControl(input.expectedRevision, current => {
      const admin = actor(current, user.subject); requireAdmin(admin);
      const index = current.users.findIndex(u => u.id === input.id);
      if (index < 0) throw new ApiError(404, 'USER_NOT_FOUND', '사용자를 찾을 수 없습니다.');
      const before = current.users[index];
      const after = { ...before, displayName: input.displayName, role: input.role, status: input.status };
      if (before.role === 'ADMIN' && before.status === 'ACTIVE' && (after.role !== 'ADMIN' || after.status !== 'ACTIVE') && !current.users.some(u => u.id !== before.id && u.role === 'ADMIN' && u.status === 'ACTIVE')) throw new ApiError(409, 'LAST_ADMIN', '마지막 활성 관리자의 권한을 제거할 수 없습니다.');
      current.users[index] = after;
      audit(current, admin, 'USER', input.id, null, 'USER_UPDATED', publicUser(before), publicUser(after), input.reason);
      return current;
    });
    return json({ revision: next.revision });
  }
  if (path === '/api/admin/departments' && ['POST', 'PATCH'].includes(method)) {
    requireAdmin(user);
    const input = method === 'POST' ? departmentCreateInput.parse(await args.body()) : departmentUpdateInput.parse(await args.body());
    const id = 'id' in input && typeof input.id === 'string' ? input.id : randomUUID();
    const next = await repo.updateControl(input.expectedRevision, current => {
      const admin = actor(current, user.subject); requireAdmin(admin);
      const index = current.departments.findIndex(d => d.id === id);
      if (method === 'PATCH' && index < 0) throw new ApiError(404, 'DEPARTMENT_NOT_FOUND', '부서를 찾을 수 없습니다.');
      if (current.departments.some(d => d.id !== id && code(d.code) === code(input.code))) throw new ApiError(409, 'DEPARTMENT_CODE_DUPLICATE', '이미 등록된 부서 코드입니다.');
      const before = index < 0 ? null : current.departments[index];
      const after = { id, code: code(input.code), name: input.name, status: input.status, managementPeriod: input.managementPeriod ?? before?.managementPeriod ?? 'MONTHLY', createdAt: before?.createdAt ?? new Date().toISOString() };
      if (index < 0) current.departments.push(after); else current.departments[index] = after;
      audit(current, admin, 'DEPARTMENT', id, id, before ? 'DEPARTMENT_UPDATED' : 'DEPARTMENT_CREATED', before, after, input.reason);
      return current;
    });
    return json({ department: next.departments.find(d => d.id === id), revision: next.revision }, method === 'POST' ? 201 : 200);
  }
  if (path === '/api/accounts') {
    if (method === 'GET') {
      const departmentId = url.searchParams.get('departmentId') ?? '';
      requireDepartment(state, user, departmentId);
      return json({ accounts: state.accounts.filter(a => a.departmentId === departmentId).sort((a,b) => a.sortOrder-b.sortOrder || a.code.localeCompare(b.code)), revision: state.revision });
    }
    if (method === 'POST' || method === 'PATCH') {
      const input = method === 'POST' ? accountCreateInput.parse(await args.body()) : accountUpdateInput.parse(await args.body());
      activeDepartment(state, user, input.departmentId);
      const id = 'id' in input && typeof input.id === 'string' ? input.id : randomUUID();
      const next = await repo.updateControl(input.expectedRevision, current => {
        const writer = actor(current, user.subject); activeDepartment(current, writer, input.departmentId);
        const index = current.accounts.findIndex(a => a.id === id && a.departmentId === input.departmentId);
        if (method === 'PATCH' && index < 0) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '이 부서의 계정코드를 찾을 수 없습니다.');
        if (current.accounts.some(a => a.id !== id && a.departmentId === input.departmentId && code(a.code) === code(input.code))) throw new ApiError(409, 'ACCOUNT_CODE_DUPLICATE', '이 부서에 같은 계정코드가 있습니다.');
        const before = index < 0 ? null : current.accounts[index];
        // Until the transaction reference index exists, conservatively forbid all type changes.
        if (before && before.type !== input.type) throw new ApiError(409, 'ACCOUNT_TYPE_IMMUTABLE', '계정 유형은 변경할 수 없습니다. 다른 유형의 계정을 새로 등록해 주세요.');
        const after = { id, departmentId: input.departmentId, code: code(input.code), name: input.name, type: input.type, sortOrder: input.sortOrder, status: input.status };
        if (index < 0) current.accounts.push(after); else current.accounts[index] = after;
        audit(current, writer, 'ACCOUNT', id, input.departmentId, before ? 'ACCOUNT_UPDATED' : 'ACCOUNT_CREATED', before, after, input.reason);
        return current;
      });
      return json({ account: next.accounts.find(a => a.id === id), revision: next.revision }, method === 'POST' ? 201 : 200);
    }
  }
  return null;
}
