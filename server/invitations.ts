import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Control, type User } from './schema';
import { ApiError, type Repository } from './store';
import { koreaDate, requireAdmin } from './policy';
import { configuredInvitations, type InvitationProvider, type RemoteIdentity } from './auth0-management';

type Invitation = NonNullable<Control['invitations']>[number];
const createInput = z.object({ requestId: z.uuid(), displayName: z.string().trim().min(1).max(80), email: z.email().max(254).transform(s => s.toLowerCase()), departmentId: z.uuid(), expectedRevision: z.number().int().positive() }).strict();
const retryInput = z.object({ id: z.uuid() }).strict();
const errorCode = (error: unknown) => error instanceof ApiError ? error.code : 'UNKNOWN';
const json = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });

export async function handleInvitations(args: { path: string; method: string; user: User; repo: Repository; body: () => Promise<unknown>; provider?: () => InvitationProvider; now?: () => number }): Promise<Response | null> {
  const { path, method, repo, user } = args;
  if (path !== '/api/admin/invitations' && path !== '/api/admin/invitations/retry') return null;
  requireAdmin(user);
  if (path === '/api/admin/invitations' && method === 'GET') {
    const state = await repo.control();
    let configured = false;
    try { (args.provider ?? configuredInvitations)(); configured = true; } catch { /* No secret details in capability response. */ }
    return json({ configured, invitations: (state.invitations ?? []).map(({ subject, operationId, leaseUntil, mailAttempts, ...i }) => ({ ...i, nextRetryAt: Math.max(leaseUntil, (mailAttempts.at(-1) ?? 0) + 120000) })), revision: state.revision });
  }
  if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 메서드입니다.');
  if (!repo.writable) throw new ApiError(503, 'WRITE_NOT_VERIFIED', '저장소 쓰기가 허용되지 않았습니다.');
  const remote = (args.provider ?? configuredInvitations)();
  const now = args.now ?? Date.now;
  const operationId = randomUUID();
  // Optimistic revision updates are the repository's verified concurrency primitive.
  // No network calls run inside a database transaction or row lock.
  async function mutate(change: (state: Control) => void, expected?: number) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await repo.control();
      try {
        return await repo.updateControl(expected ?? snapshot.revision, state => {
          const admin = state.users.find(u => u.id === user.id && u.subject === user.subject && u.status === 'ACTIVE');
          if (!admin) throw new ApiError(401, 'UNAUTHENTICATED', '관리자 로그인이 필요합니다.');
          requireAdmin(admin); change(state); return state;
        });
      } catch (e) { if (expected !== undefined || errorCode(e) !== 'VERSION_CONFLICT' || attempt === 4) throw e; }
    }
    throw new ApiError(409, 'VERSION_CONFLICT', '새로 조회한 뒤 다시 시도하세요.');
  }
  function audit(state: Control, i: Invitation, reason: string) {
    state.audit.push({ id: randomUUID(), actorUserId: user.id, departmentId: i.departmentId, entityType: 'USER', entityId: i.userId ?? i.id, action: 'INVITATION_UPDATED', occurredAt: new Date(now()).toISOString(), reason, before: null, after: { invitationId: i.id, status: i.status, errorCode: i.errorCode ?? null, userId: i.userId ?? null } });
  }
  function item(state: Control, id: string, owned = true) {
    const i = state.invitations?.find(v => v.id === id);
    if (!i) throw new ApiError(404, 'INVITATION_NOT_FOUND', '초대를 찾을 수 없습니다.');
    if (owned && i.operationId !== operationId) throw new ApiError(409, 'INVITATION_BUSY', '다른 요청이 이 초대를 처리하고 있습니다. 상태를 새로 조회하세요.');
    if (!state.departments.some(d => d.id === i.departmentId && d.status === 'ACTIVE')) throw new ApiError(409, 'DEPARTMENT_INACTIVE', '초대한 부서가 사용 중지되었습니다.');
    if (i.userId && !state.users.some(u => u.id === i.userId && u.status === 'ACTIVE')) throw new ApiError(409, 'USER_DISABLED', '사용 중지된 사용자에게 재발송할 수 없습니다.');
    return i;
  }
  let id: string, create = false;
  if (path === '/api/admin/invitations') {
    const input = createInput.parse(await args.body()); id = input.requestId;
    const current = await repo.control();
    const existing = current.invitations?.find(i => i.id === id);
    if (existing) {
      if (existing.email !== input.email || existing.displayName !== input.displayName || existing.departmentId !== input.departmentId) throw new ApiError(409, 'REQUEST_ID_REUSED', '같은 요청 ID를 다른 초대에 사용할 수 없습니다.');
      return json({ id, status: existing.status, message: '이미 접수된 초대입니다. 상태를 확인한 뒤 재시도하세요.' });
    }
    await mutate(state => {
      if (!state.departments.some(d => d.id === input.departmentId && d.status === 'ACTIVE')) throw new ApiError(422, 'DEPARTMENT_REQUIRED', '활성 담당 부서를 선택하세요.');
      if (state.invitations?.some(i => i.email === input.email || i.id === id)) throw new ApiError(409, 'INVITATION_DUPLICATE', '이미 접수된 이메일입니다. 초대 목록에서 확인하세요.');
      const invitation: Invitation = { id, email: input.email, displayName: input.displayName, departmentId: input.departmentId, createdBy: user.id, createdAt: new Date(now()).toISOString(), operationId, status: 'CREATING', leaseUntil: now() + 120000, mailAttempts: [] };
      (state.invitations ??= []).push(invitation); audit(state, invitation, '회계담당자 초대 접수');
    }, input.expectedRevision);
    create = true;
  } else {
    id = retryInput.parse(await args.body()).id;
    await mutate(state => {
      const i = item(state, id, false);
      if (i.leaseUntil > now()) throw new ApiError(429, 'INVITATION_BUSY', '처리 중이거나 재시도 대기 중입니다. 2분 후 확인하세요.');
      if (i.status === 'REVIEW_REQUIRED') throw new ApiError(409, 'IDENTITY_REVIEW_REQUIRED', '기존 인증 계정이 있어 자동 연결할 수 없습니다. 본인 확인 절차가 필요합니다.');
      create = i.status === 'CREATE_FAILED';
      i.leaseUntil = now() + 120000;
      i.operationId = operationId;
      if (create) i.status = 'CREATING';
      audit(state, i, '초대 재시도 접수');
    });
  }
  let i = item(await repo.control(), id);
  if (!i.subject) {
    let identity: RemoteIdentity;
    try {
      const matches = await remote.find(i.email);
      const owned = matches.filter(m => m.invitationId === id && m.application === 'https://cool-scone-571b5f.netlify.app' && m.connection === 'Username-Password-Authentication' && m.email.toLowerCase() === i.email && m.subject.startsWith('auth0|'));
      if (matches.length) {
        if (matches.length !== 1 || owned.length !== 1) throw new ApiError(409, 'EXISTING_ACCOUNT', '기존 인증 계정은 이메일만으로 연결하지 않습니다.');
        identity = owned[0];
      } else {
        if (!create) throw new ApiError(409, 'CREATE_UNKNOWN', '이전 계정 생성 결과를 아직 확인하지 못했습니다. 중복 생성하지 않고 보류합니다.');
        identity = await remote.create({ email: i.email, displayName: i.displayName, invitationId: id });
      }
      if (identity.invitationId !== id || identity.application !== 'https://cool-scone-571b5f.netlify.app' || identity.connection !== 'Username-Password-Authentication' || identity.email.toLowerCase() !== i.email || !identity.subject.startsWith('auth0|')) throw new ApiError(409, 'CREATE_UNKNOWN', '인증 계정의 생성 출처 확인이 필요합니다.');
    } catch (e) {
      const code = errorCode(e);
      await mutate(state => { const v = item(state, id); v.status = code === 'EXISTING_ACCOUNT' ? 'REVIEW_REQUIRED' : code === 'CREATE_FAILED' || code === 'REMOTE_LOOKUP_FAILED' || code === 'MANAGEMENT_AUTH_FAILED' ? 'CREATE_FAILED' : 'CREATING'; v.errorCode = code === 'EXISTING_ACCOUNT' ? 'EXISTING_ACCOUNT' : v.status === 'CREATE_FAILED' ? 'CREATE_FAILED' : 'CREATE_UNKNOWN'; audit(state, v, 'Auth0 계정 생성 실패 또는 확인 보류'); });
      return json({ id, status: (await repo.control()).invitations!.find(v => v.id === id)!.status, message: '계정 생성이 완료되지 않았습니다. 초대 목록에서 상태를 확인하세요.' }, 202);
    }
    await mutate(state => {
      const v = item(state, id);
      if (v.subject) { if (v.subject !== identity.subject) throw new ApiError(409, 'IDENTITY_CONFLICT', '인증 계정 연결 충돌입니다.'); return; }
      if (state.users.some(u => u.subject === identity.subject)) throw new ApiError(409, 'IDENTITY_CONFLICT', '이미 연결된 인증 계정입니다.');
      const userId = randomUUID();
      state.users.push({ id: userId, subject: identity.subject, loginId: `invite.${id}`, displayName: v.displayName, role: 'ACCOUNTANT', status: 'ACTIVE', createdAt: new Date(now()).toISOString() });
      state.assignments.push({ id: randomUUID(), userId, departmentId: v.departmentId, validFrom: koreaDate(new Date(now())), validTo: null, assignedBy: user.id, reason: '신규 회계담당자 초대 배정' });
      v.subject = identity.subject; v.userId = userId; v.status = 'ACCOUNT_READY'; delete v.errorCode;
      audit(state, v, 'Auth0 반환 식별자 연결 및 담당 부서 배정');
    });
    i = item(await repo.control(), id);
  }
  await mutate(state => {
    const v = item(state, id), since = now() - 3600000;
    if ((v.mailAttempts.at(-1) ?? 0) + 120000 > now()) throw new ApiError(429, 'MAIL_COOLDOWN', '메일 재요청은 2분 후 가능합니다.');
    if (v.mailAttempts.filter(t => t > since).length >= 3 || (state.invitations ?? []).flatMap(x => x.mailAttempts).filter(t => t > now() - 60000).length >= 5) throw new ApiError(429, 'MAIL_RATE_LIMIT', '메일 요청 한도에 도달했습니다. 잠시 후 재시도하세요.');
    v.mailAttempts = [...v.mailAttempts.filter(t => t > since), now()]; v.status = 'MAIL_REQUESTING'; v.leaseUntil = now() + 120000; delete v.errorCode; audit(state, v, '비밀번호 설정 메일 요청 시작');
  });
  let mailError: string | undefined;
  try {
    const matches = await remote.find(i.email);
    if (matches.length !== 1 || matches[0].subject !== i.subject || matches[0].invitationId !== id || matches[0].application !== 'https://cool-scone-571b5f.netlify.app' || matches[0].connection !== 'Username-Password-Authentication') throw new ApiError(409, 'MAIL_FAILED', '메일 대상 인증 계정이 변경되어 발송을 중단했습니다.');
    await mutate(state => { item(state, id); });
    await remote.sendPasswordEmail(i.email);
  } catch (e) { mailError = errorCode(e); }
  await mutate(state => {
    const v = item(state, id); v.status = mailError ? 'MAIL_FAILED' : 'MAIL_ACCEPTED';
    if (mailError) v.errorCode = mailError === 'MAIL_FAILED' ? 'MAIL_FAILED' : 'MAIL_UNKNOWN';
    audit(state, v, mailError ? '비밀번호 설정 메일 요청 실패 또는 결과 불명' : 'Auth0가 비밀번호 설정 메일 요청을 접수함 (수신 미확인)');
  });
  return json({ id, status: mailError ? 'MAIL_FAILED' : 'MAIL_ACCEPTED', message: mailError ? '계정은 등록되었지만 메일 요청 확인에 실패했습니다. 초대 목록에서 재발송하세요.' : 'Auth0가 메일 요청을 접수했습니다. 실제 수신 여부는 담당자가 확인해야 합니다.' }, mailError ? 202 : 201);
}
