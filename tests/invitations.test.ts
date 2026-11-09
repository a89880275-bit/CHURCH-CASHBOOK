import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileRepository } from '../server/file-store';
import { createApi } from '../server/api';
import { issueSession } from '../server/auth';
import { ids, seed } from '../server/seed';
import { ApiError } from '../server/store';
import { auth0Management, type InvitationProvider, type RemoteIdentity } from '../server/auth0-management';

const origin = 'http://127.0.0.1:5173', application = 'https://cool-scone-571b5f.netlify.app';
let repo: FileRepository, root: string, admin: string, accountant: string, api: ReturnType<typeof createApi>;
let identities: RemoteIdentity[], remote: InvitationProvider;
const input = () => ({ requestId: randomUUID(), displayName: '초대 담당자', email: 'invite@example.com', departmentId: ids.edu, expectedRevision: 1 });
function request(path: string, data?: unknown, cookie = admin) {
  return api(new Request(origin + '/api/admin/invitations' + path, { method: data ? 'POST' : 'GET', headers: { origin, cookie, ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cashbook-invite-')); repo = new FileRepository(root); await repo.initialize(seed());
  admin = (await issueSession(repo, 'local:admin', true)).split(';')[0]; accountant = (await issueSession(repo, 'local:accountant', true)).split(';')[0];
  identities = [];
  remote = {
    find: vi.fn(async () => identities),
    create: vi.fn(async i => { const identity = { subject: 'auth0|new-id', invitationId: i.invitationId, email: i.email, application, connection: 'Username-Password-Authentication' }; identities.push(identity); return identity; }),
    sendPasswordEmail: vi.fn(async () => {}),
  };
  api = createApi(repo, { origin, local: true, invitationProvider: () => remote });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function later() { const time = Date.now() + 121000; vi.spyOn(Date, 'now').mockReturnValue(time); }

describe('department accountant invitation saga with persisted JSON', () => {
  it('links only the created subject, assigns a department and preserves existing records', async () => {
    const before = await repo.control(), body = input();
    expect((await request('', body)).status).toBe(201);
    const state = await repo.control(), invitation = state.invitations![0], user = state.users.find(u => u.id === invitation.userId)!;
    expect(user.role).toBe('ACCOUNTANT'); expect(user.subject).toBe('auth0|new-id');
    expect(state.users.slice(0, 3)).toEqual(before.users); expect(state.assignments.slice(0, 2)).toEqual(before.assignments);
    expect(state.transactionRefs).toEqual(before.transactionRefs); expect(invitation.status).toBe('MAIL_ACCEPTED');
    const cookie = (await issueSession(repo, user.subject, true)).split(';')[0];
    const me = await api(new Request(origin + '/api/me', { headers: { cookie } }));
    expect((await me.json()).data.departments.map((d: any) => d.id)).toEqual([ids.edu]);
    expect(state.audit.length).toBeGreaterThanOrEqual(4);
  });
  it('denies anonymous, non-admin and forged origin before contacting Auth0', async () => {
    expect((await request('', input(), '')).status).toBe(401);
    expect((await request('', input(), accountant)).status).toBe(403);
    expect((await api(new Request(origin + '/api/admin/invitations', { method: 'POST', headers: { cookie: admin, origin: 'https://evil.invalid' } }))).status).toBe(403);
    expect(remote.create).not.toHaveBeenCalled();
  });
  it('does not accept administrator role or browser-supplied subject', async () => {
    expect((await request('', { ...input(), role: 'ADMIN' })).status).toBe(422);
    expect((await request('', { ...input(), subject: 'auth0|admin' })).status).toBe(422);
    expect(remote.create).not.toHaveBeenCalled();
  });
  it('never links a pre-existing same-email or social account', async () => {
    identities.push({ subject: 'google-oauth2|old', email: 'invite@example.com', connection: 'google-oauth2' });
    expect((await request('', input())).status).toBe(202);
    expect((await repo.control()).invitations![0].status).toBe('REVIEW_REQUIRED');
    expect((await repo.control()).users).toHaveLength(3); expect(remote.create).not.toHaveBeenCalled(); expect(remote.sendPasswordEmail).not.toHaveBeenCalled();
  });
  it('makes duplicate request IDs idempotent and rejects payload changes', async () => {
    const body = input(); await request('', body);
    expect((await request('', body)).status).toBe(200);
    expect((await request('', { ...body, displayName: '다른 사람' })).status).toBe(409);
    expect(remote.create).toHaveBeenCalledTimes(1); expect(remote.sendPasswordEmail).toHaveBeenCalledTimes(1);
  });
  it('serializes simultaneous same-email reservations before external creation', async () => {
    const responses = await Promise.all([request('', input()), request('', input())]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect(remote.create).toHaveBeenCalledTimes(1); expect((await repo.control()).invitations).toHaveLength(1);
  });
  it('recovers an ambiguous create from its server-owned metadata without a second create', async () => {
    const create = remote.create;
    remote.create = vi.fn(async i => { await create(i); throw new ApiError(503, 'CREATE_UNKNOWN', 'uncertain'); });
    const body = input(); expect((await request('', body)).status).toBe(202);
    expect((await request('/retry', { id: body.requestId })).status).toBe(429);
    later(); expect((await request('/retry', { id: body.requestId })).status).toBe(201);
    expect(remote.create).toHaveBeenCalledTimes(1); expect((await repo.control()).users).toHaveLength(4);
  });
  it('holds an unresolved create rather than blindly creating another account', async () => {
    remote.create = vi.fn(async () => { throw new ApiError(503, 'CREATE_UNKNOWN', 'uncertain'); });
    const body = input(); await request('', body); later();
    expect((await request('/retry', { id: body.requestId })).status).toBe(202);
    expect(remote.create).toHaveBeenCalledTimes(1); expect(remote.sendPasswordEmail).not.toHaveBeenCalled();
  });
  it('retries a definite creation failure after the cooldown', async () => {
    const create = remote.create;
    remote.create = vi.fn().mockRejectedValueOnce(new ApiError(503, 'CREATE_FAILED', 'definite')).mockImplementation(create);
    const body = input(); await request('', body); later();
    expect((await request('/retry', { id: body.requestId })).status).toBe(201);
    expect(remote.create).toHaveBeenCalledTimes(2);
  });
  it('persists account mapping on mail failure and resends without recreating', async () => {
    remote.sendPasswordEmail = vi.fn().mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_BODY')).mockResolvedValue(undefined);
    const body = input(), response = await request('', body);
    expect(response.status).toBe(202); expect(await response.text()).not.toContain('PRIVATE_PROVIDER_BODY');
    expect((await repo.control()).invitations![0].errorCode).toBe('MAIL_UNKNOWN');
    later(); expect((await request('/retry', { id: body.requestId })).status).toBe(201);
    expect(remote.create).toHaveBeenCalledTimes(1); expect(remote.sendPasswordEmail).toHaveBeenCalledTimes(2);
  });
  it('retains a recoverable reservation if DB linking fails after Auth0 creation', async () => {
    const update = repo.updateControl.bind(repo); let fail = true;
    vi.spyOn(repo, 'updateControl').mockImplementation(async (revision, change) => {
      return update(revision, state => { const next = change(state); if (fail && next.users.length > 3) { fail = false; throw new Error('disk failure'); } return next; });
    });
    const body = input(); expect((await request('', body)).status).toBe(503);
    expect((await repo.control()).users).toHaveLength(3); later();
    expect((await request('/retry', { id: body.requestId })).status).toBe(201); expect(remote.create).toHaveBeenCalledTimes(1);
  });
  it('blocks resends and existing sessions immediately after app deactivation', async () => {
    const body = input(); await request('', body); const state = await repo.control(), userId = state.invitations![0].userId!;
    const cookie = (await issueSession(repo, 'auth0|new-id', true)).split(';')[0];
    await repo.updateControl(state.revision, s => { s.users.find(u => u.id === userId)!.status = 'DISABLED'; return s; });
    later(); expect((await request('/retry', { id: body.requestId })).status).toBe(409);
    expect((await api(new Request(origin + '/api/me', { headers: { cookie } }))).status).toBe(401);
    expect((await repo.control()).assignments.some(a => a.userId === userId)).toBe(true);
  });
  it('rechecks actor status after an external call before binding', async () => {
    const create = remote.create;
    remote.create = vi.fn(async i => { const identity = await create(i), state = await repo.control(); await repo.updateControl(state.revision, s => { s.users.find(u => u.id === ids.b)!.role = 'ADMIN'; s.users[0].status = 'DISABLED'; return s; }); return identity; });
    expect((await request('', input())).status).toBe(401);
    expect((await repo.control()).users).toHaveLength(3); expect(remote.sendPasswordEmail).not.toHaveBeenCalled();
  });
  it('does not resend to an email reassigned to a different identity', async () => {
    const body = input(); await request('', body); identities[0] = { ...identities[0], subject: 'auth0|someone-else' }; later();
    expect((await request('/retry', { id: body.requestId })).status).toBe(202); expect(remote.sendPasswordEmail).toHaveBeenCalledTimes(1);
  });
  it('never exposes subject or worker lease identifiers through invitation list', async () => {
    await request('', input()); const response = await request(''), text = await response.text();
    expect(text).not.toContain('auth0|new-id'); expect(text).not.toContain('operationId'); expect(text).not.toContain('mailAttempts');
  });
  it('limits resend attempts even when mail fails', async () => {
    const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    remote.sendPasswordEmail = vi.fn(async () => { throw new ApiError(503, 'MAIL_FAILED', 'failed'); });
    const body = input(); await request('', body);
    for (let n = 1; n <= 2; n++) { clock.mockReturnValue(start + n * 121000); expect((await request('/retry', { id: body.requestId })).status).toBe(202); }
    clock.mockReturnValue(start + 363000);
    expect((await request('/retry', { id: body.requestId })).status).toBe(429);
    expect(remote.sendPasswordEmail).toHaveBeenCalledTimes(3);
  });
  it('fences a stale creation worker after recovery takes over its lease', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let created!: () => void;
    const ready = new Promise<void>(resolve => { created = resolve; });
    const create = remote.create;
    remote.create = vi.fn(async i => { const identity = await create(i); created(); await wait; return identity; });
    const body = input(), first = request('', body);
    await ready; later();
    expect((await request('/retry', { id: body.requestId })).status).toBe(201);
    release(); expect((await first).status).toBe(409);
    expect(remote.create).toHaveBeenCalledTimes(1); expect(remote.sendPasswordEmail).toHaveBeenCalledTimes(1);
    expect((await repo.control()).users).toHaveLength(4);
  });
});

describe('Auth0 server adapter (HTTP contract mocks, not live email proof)', () => {
  const config = { domain: 'example.auth0.com', clientId: 'server', clientSecret: 'PRIVATE_SECRET', loginClientId: 'login', issuer: 'https://example.auth0.com/', connection: 'Username-Password-Authentication', application };
  it('uses server-only client credentials and random password; requests reset using login client', async () => {
    const calls: { path: string; body: any }[] = [];
    const fetcher = vi.fn(async (url: any, init: any) => {
      const path = new URL(url).pathname, body = JSON.parse(init.body); calls.push({ path, body });
      if (path === '/oauth/token') return Response.json({ access_token: 'SERVER_TOKEN', scope: 'read:users create:users', expires_in: 3600 });
      if (path === '/api/v2/users') return Response.json({ user_id: 'auth0|created', email: body.email, identities: [{ provider: 'auth0', connection: config.connection }], app_metadata: body.app_metadata });
      return new Response('accepted');
    }) as unknown as typeof fetch;
    const provider = auth0Management(config, fetcher), id = randomUUID();
    const created = await provider.create({ email: 'new@example.com', displayName: '담당자', invitationId: id });
    await provider.sendPasswordEmail('new@example.com');
    expect(created.subject).toBe('auth0|created'); expect(JSON.stringify(created)).not.toContain('PRIVATE_SECRET');
    const create = calls.find(c => c.path === '/api/v2/users')!.body;
    expect(create.password.length).toBeGreaterThan(60); expect(create.email_verified).toBe(false); expect(create.verify_email).toBe(false);
    expect(calls.at(-1)!.body).toEqual({ client_id: 'login', connection: config.connection, email: 'new@example.com' });
  });
  it('refuses tenant mismatch, login client reuse and other deployment targets', () => {
    expect(() => auth0Management({ ...config, issuer: 'https://other.auth0.com' })).toThrow();
    expect(() => auth0Management({ ...config, clientId: 'login' })).toThrow();
    expect(() => auth0Management({ ...config, application: 'https://operating.example' })).toThrow();
  });
  it('does not leak upstream errors and treats 5xx create as ambiguous', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'TOKEN', scope: 'read:users create:users' })).mockResolvedValueOnce(new Response('PRIVATE_SECRET', { status: 500 }));
    const provider = auth0Management(config, fetcher);
    await expect(provider.create({ email: 'new@example.com', displayName: '담당자', invitationId: randomUUID() })).rejects.toMatchObject({ code: 'CREATE_UNKNOWN' });
  });
});
