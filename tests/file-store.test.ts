import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRepository, decodeSnapshot, encodeSnapshot } from '../server/file-store';
import { seed, ids } from '../server/seed';
import { digest, issueSession } from '../server/auth';
import { createApi } from '../server/api';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let root: string;
let repo: FileRepository;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'accounting-store-')); repo = new FileRepository(root); await repo.initialize(seed()); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('actual local JSON filesystem storage (not remote Blobs)', () => {
  it('retries transient Windows rename sharing errors without unlinking current data', async () => {
    let attempts = 0;
    const windows = new FileRepository(root, { replaceFile: async (from, to) => {
      if (++attempts <= 2) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      await rename(from, to);
    } });
    await windows.updateControl(1, s => { s.departments[0].name = '재시도 성공'; return s; });
    expect(attempts).toBe(3); expect((await repo.control()).departments[0].name).toBe('재시도 성공');
  });
  it('permanent rename refusal times out without losing data or retaining the writer lock', async () => {
    const before = await readFile(join(root, 'current.json'), 'utf8');
    const denied = new FileRepository(root, { replaceTimeoutMs: 30, replaceFile: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } });
    await expect(denied.updateControl(1, s => { s.departments[0].name = '실패'; return s; })).rejects.toMatchObject({ code: 'STORAGE_PUBLISH_FAILED' });
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(before);
    await repo.updateControl(1, s => s);
  });
  it('serializes writers in two actual Node processes using the filesystem lock', async () => {
    const run = promisify(execFile);
    const result = await Promise.all(['프로세스 A', '프로세스 B'].map(name => run(process.execPath, ['--import', 'tsx', 'tests/fixtures/file-writer.ts', root, name])));
    expect(result.map(r => r.stdout).sort()).toEqual(['COMMITTED', 'CONFLICT']);
    expect((await repo.control()).revision).toBe(2);
  }, 15000);
  it('persists updates across repository reopening', async () => {
    await repo.updateControl(1, s => { s.departments[0].name = '저장한 부서명'; return s; });
    const reopened = new FileRepository(root);
    expect((await reopened.control()).departments[0].name).toBe('저장한 부서명');
    expect((await reopened.control()).revision).toBe(2);
  });
  it('never overwrites existing data during initialization', async () => {
    await repo.updateControl(1, s => { s.departments[0].name = '기존 기록'; return s; });
    await new FileRepository(root).initialize(seed());
    expect((await repo.control()).departments[0].name).toBe('기존 기록');
  });
  it('two independent writers get one success and one 409 with no silent overwrite', async () => {
    const a = new FileRepository(root), b = new FileRepository(root);
    const results = await Promise.allSettled([a.updateControl(1, s => { s.departments[0].name = '변경 A'; return s; }), b.updateControl(1, s => { s.departments[1].name = '변경 B'; return s; })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    // Explicit re-read/retry preserves BOTH changes; no automatic last-write wins.
    const latest = await repo.control();
    await repo.updateControl(latest.revision, s => { s.departments[0].name = '변경 A'; s.departments[1].name = '변경 B'; return s; });
    expect((await repo.control()).departments.map(d => d.name)).toEqual(['변경 A', '변경 B', '선교부']);
  });
  it('readers see complete valid snapshots while repeated renames publish updates', async () => {
    await Promise.all([
      (async () => { for (let i = 1; i <= 15; i++) await repo.updateControl(i, s => { s.departments[0].name = '부서 ' + i; return s; }); })(),
      (async () => { for (let i = 0; i < 50; i++) expect((await new FileRepository(root).control()).schemaVersion).toBe(1); })(),
    ]);
    expect((await repo.control()).revision).toBe(16);
  });
  it('injected failure after file flush and before publish preserves exact current bytes', async () => {
    const before = await readFile(join(root, 'current.json'), 'utf8');
    const failed = new FileRepository(root, { beforePublish: async () => { throw new Error('simulated disk publish failure'); } });
    await expect(failed.updateControl(1, s => { s.departments[0].name = '저장 실패'; return s; })).rejects.toThrow('simulated');
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(before);
    expect((await readdir(root)).some(x => x.endsWith('.tmp'))).toBe(false);
    await repo.updateControl(1, s => s); // lock released after failure
  });
  it('backup-write failure leaves current data untouched', async () => {
    const before = await readFile(join(root, 'current.json'), 'utf8');
    await rm(join(root, 'snapshots'), { recursive: true });
    await writeFile(join(root, 'snapshots'), 'not a directory');
    await expect(repo.updateControl(1, s => s)).rejects.toThrow();
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(before);
  });
  it('schema failure does not commit or increment revision', async () => {
    await expect(repo.updateControl(1, s => { s.users[0].status = 'DISABLED'; return s; })).rejects.toThrow();
    expect((await repo.control()).revision).toBe(1);
    expect(await repo.snapshotNames()).toEqual([]);
  });
  it('checksum corruption fails closed and initialize never silently resets it', async () => {
    const envelope = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
    envelope.payload.departments[0].name = '외부 변조';
    const invalid = JSON.stringify(envelope);
    await writeFile(join(root, 'current.json'), invalid);
    await expect(repo.control()).rejects.toMatchObject({ code: 'STORAGE_INVALID' });
    await expect(repo.initialize(seed())).rejects.toMatchObject({ code: 'STORAGE_INVALID' });
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(invalid);
  });
  it('stale lock is not stolen based on an assumed lease timeout', async () => {
    await mkdir(join(root, 'write.lock'));
    await expect(new FileRepository(root, { lockTimeoutMs: 30 }).updateControl(1, s => s)).rejects.toMatchObject({ code: 'STORAGE_LOCKED' });
    expect((await repo.control()).revision).toBe(1);
  });
  it('previous snapshot can be validated and restored in a controlled storage rehearsal', async () => {
    const original = await repo.control();
    await repo.updateControl(1, s => { s.departments[0].name = '새 부서명'; return s; });
    const names = await repo.snapshotNames(); expect(names).toHaveLength(1);
    const backup = await repo.readSnapshot(names[0]); expect(backup).toEqual(original);
    // Internal repository rehearsal only. Web restore workflow remains Phase 4.
    await repo.updateControl(2, () => backup);
    const restored = await repo.control(); expect(restored.departments).toEqual(original.departments);
    expect(restored.assignments).toEqual(original.assignments); expect(restored.revision).toBe(3);
    expect(() => decodeSnapshot(encodeSnapshot(restored).replace('교육부', '변조'))).toThrow();
  });
  it('persists sessions and deletion rejects a replayed cookie through API', async () => {
    const cookie = (await issueSession(repo, 'local:admin', true)).split(';')[0];
    const api = createApi(new FileRepository(root), { origin: 'http://127.0.0.1:5173', local: true });
    const request = (path: string, post = false) => new Request('http://127.0.0.1:5173/api' + path, { method: post ? 'POST' : 'GET', headers: { cookie, origin: 'http://127.0.0.1:5173' } });
    expect((await api(request('/me'))).status).toBe(200);
    expect((await api(request('/auth/logout', true))).status).toBe(200);
    expect((await api(request('/me'))).status).toBe(401);
    expect(await repo.session(digest(cookie.split('=')[1]))).toBeNull();
  });
  it('filesystem API rechecks assignment changes for existing sessions', async () => {
    const cookie = (await issueSession(repo, 'local:accountant', true)).split(';')[0];
    await repo.updateControl(1, s => { s.assignments = s.assignments.filter(a => a.departmentId !== ids.edu); return s; });
    const api = createApi(new FileRepository(root), { origin: 'http://127.0.0.1:5173', local: true });
    expect((await api(new Request('http://127.0.0.1:5173/api/accounts?departmentId=' + ids.edu, { headers: { cookie } }))).status).toBe(403);
    expect((await api(new Request('http://127.0.0.1:5173/api/accounts?departmentId=' + ids.music, { headers: { cookie } }))).status).toBe(200);
  });
});
