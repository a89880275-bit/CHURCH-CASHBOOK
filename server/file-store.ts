import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { controlSchema, transactionSchema, transactionRefSchema, type Control, type Transaction, type TransactionRef } from './schema';
import { ApiError, type Repository, type Session } from './store';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function encodeSnapshot(value: Control) {
  const payload = controlSchema.parse(value);
  return JSON.stringify({ format: 1, checksum: hash(payload), payload }, null, 2);
}
export function decodeSnapshot(text: string): Control {
  try {
    const envelope = JSON.parse(text);
    if (envelope.format !== 1 || envelope.checksum !== hash(envelope.payload)) throw new Error('checksum');
    return controlSchema.parse(envelope.payload);
  } catch { throw new ApiError(503, 'STORAGE_INVALID', 'JSON 저장소의 형식 또는 체크섬이 올바르지 않습니다. 원본을 보존하고 백업을 확인해 주세요.'); }
}
const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const sessionSchema = z.object({ subject: z.string().min(1), expiresAt: z.number().finite() }).strict();

/** Local disk only. Never instantiate inside a Netlify Function or on a network share.
 * Cooperative writers use exclusive mkdir; a stale lock is NEVER forcibly stolen.
 * Existing revision + audit + master data are published by a same-directory rename.
 * Tests cover this OS/filesystem; this is not a power-loss or cloud storage guarantee.
 */
export class FileRepository implements Repository {
  readonly writable = true;
  readonly root: string;
  constructor(root: string, private options: {
    lockTimeoutMs?: number; beforePublish?: () => Promise<void>;
    replaceFile?: typeof rename; replaceTimeoutMs?: number;
  } = {}) {
    this.root = resolve(root);
  }
  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, 'write.lock');
    const deadline = Date.now() + (this.options.lockTimeoutMs ?? 3000);
    while (true) {
      try { await mkdir(path); break; }
      catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
        if (Date.now() >= deadline) throw new ApiError(503, 'STORAGE_LOCKED', '저장소가 사용 중입니다. 잠시 후 재시도하세요. 잠금이 계속되면 관리자 점검이 필요합니다.');
        await delay(15);
      }
    }
    try { return await fn(); }
    finally { await rmdir(path).catch(() => console.warn('STORAGE_LOCK_RELEASE_FAILED')); }
  }
  private async publish(path: string, value: string) {
    const temp = path + '.' + randomUUID() + '.tmp';
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(value, 'utf8'); await file.sync(); } finally { await file.close(); }
      await this.options.beforePublish?.();
      // Windows readers or antivirus may temporarily deny replacement. Never unlink
      // current.json as a workaround: keep the writer lock and retry ONLY rename.
      const deadline = Date.now() + (this.options.replaceTimeoutMs ?? 1500);
      let attempt = 0;
      while (true) {
        try { await (this.options.replaceFile ?? rename)(temp, path); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          if (Date.now() >= deadline) throw new ApiError(503, 'STORAGE_PUBLISH_FAILED', '파일을 교체하지 못했습니다. 기존 자료는 보존되었습니다. 재조회 후 다시 시도해 주세요.');
          await delay(Math.min(10 * 2 ** attempt++, 100));
        }
      }
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  async initialize(initial: Control) {
    await this.lock(async () => {
      await mkdir(join(this.root, 'sessions'), { recursive: true, mode: 0o700 });
      await mkdir(join(this.root, 'snapshots'), { recursive: true, mode: 0o700 });
      await mkdir(join(this.root, 'transactions'), { recursive: true, mode: 0o700 });
      try { await this.control(); }
      catch (error) {
        if (!isCode(error, 'ENOENT')) throw error;
        await this.publish(join(this.root, 'current.json'), encodeSnapshot(initial));
      }
    });
  }
  async control(): Promise<Control> {
    return decodeSnapshot(await readFile(join(this.root, 'current.json'), 'utf8'));
  }
  async updateControl(expected: number, change: (value: Control) => Control) { return this.commit(change, expected); }
  async commitLedger(change: (value: Control) => Control | Promise<Control>) { return this.commit(change); }
  private async commit(change: (value: Control) => Control | Promise<Control>, expected?: number) {
    return this.lock(async () => {
      const current = await this.control();
      if (expected !== undefined && current.revision !== expected) throw new ApiError(409, 'VERSION_CONFLICT', '다른 사용자가 자료를 변경했습니다. 입력을 확인하고 새로 조회한 뒤 다시 저장해 주세요.');
      const candidate = controlSchema.parse(await change(structuredClone(current)));
      if (expected === undefined && hash(candidate) === hash(current)) return current;
      const next = controlSchema.parse({ ...candidate, revision: current.revision + 1 });
      const old = encodeSnapshot(current);
      const backupPath = join(this.root, 'snapshots', `${current.revision}-${hash(current)}.json`);
      try {
        await writeFile(backupPath, old, { flag: 'wx', mode: 0o600, flush: true });
      } catch (error) {
        if (!isCode(error, 'EEXIST') || (await readFile(backupPath, 'utf8')) !== old) throw error;
      }
      // No changes to current.json before all schema checks and the previous snapshot succeed.
      await this.publish(join(this.root, 'current.json'), encodeSnapshot(next));
      return next;
    });
  }
  private transactionPath(ref: TransactionRef) {
    const checked = transactionRefSchema.parse(ref);
    return join(this.root, 'transactions', checked.departmentId, checked.id, `${checked.version}-${checked.hash}.json`);
  }
  async putTransaction(value: Transaction): Promise<TransactionRef> {
    const transaction = transactionSchema.parse(value);
    const ref = { id: transaction.id, departmentId: transaction.departmentId, version: transaction.version, hash: hash(transaction) };
    const path = this.transactionPath(ref);
    await mkdir(join(this.root, 'transactions', ref.departmentId, ref.id), { recursive: true, mode: 0o700 });
    const contents = JSON.stringify(transaction);
    try { await writeFile(path, contents, { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { if (!isCode(error, 'EEXIST') || await readFile(path, 'utf8') !== contents) throw error; }
    await this.readTransaction(ref);
    return ref;
  }
  async readTransaction(ref: TransactionRef): Promise<Transaction> {
    try {
      const value = transactionSchema.parse(JSON.parse(await readFile(this.transactionPath(ref), 'utf8')));
      if (hash(value) !== ref.hash || value.id !== ref.id || value.departmentId !== ref.departmentId || value.version !== ref.version || (value.status === 'DELETED' && (!value.deletedAt || !value.deletedBy || !value.deletionReason))) throw new Error('transaction integrity');
      return value;
    } catch { throw new ApiError(503, 'TRANSACTION_INVALID', '거래 JSON의 무결성을 확인하지 못했습니다. 원본과 복구 사본을 점검해 주세요.'); }
  }
  private sessionPath(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid session storage key');
    return join(this.root, 'sessions', key + '.json');
  }
  async session(key: string): Promise<Session | null> {
    try { return sessionSchema.parse(JSON.parse(await readFile(this.sessionPath(key), 'utf8'))); }
    catch (error) { if (isCode(error, 'ENOENT')) return null; throw error; }
  }
  async putSession(key: string, value: Session) { await this.publish(this.sessionPath(key), JSON.stringify(sessionSchema.parse(value))); }
  async deleteSession(key: string) { await rm(this.sessionPath(key), { force: true }); }

  // Storage verification/recovery primitive; not an administrator web restore endpoint.
  async snapshotNames() { return (await readdir(join(this.root, 'snapshots'))).filter(x => /^\d+-[a-f0-9]{64}\.json$/.test(x)); }
  async readSnapshot(name: string) {
    if (!/^\d+-[a-f0-9]{64}\.json$/.test(name)) throw new Error('Invalid snapshot name');
    return decodeSnapshot(await readFile(join(this.root, 'snapshots', name), 'utf8'));
  }
}
