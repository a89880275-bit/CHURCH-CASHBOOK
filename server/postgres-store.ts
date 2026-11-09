import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { controlSchema, transactionRefSchema, transactionSchema, type Control, type Transaction, type TransactionRef } from './schema';
import { ApiError, type Repository, type Session } from './store';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sessionSchema = z.object({ subject: z.string().min(1), expiresAt: z.number().finite(), logoutHint: z.string().min(1).max(1024).optional() }).strict();
const sessionKey = z.string().regex(/^[a-f0-9]{64}$/);

/** One control-row lock serializes all business writers, including authorization changes.
 * Immutable transactions, the manifest, revision and audit are committed together.
 * All nested repository calls use the SAME checked-out client via async context.
 * The injected Pool must be private, TLS-verified in production, and site-isolated.
 */
export class PostgresRepository implements Repository {
  readonly writable: boolean;
  private readonly context = new AsyncLocalStorage<PoolClient>();
  constructor(private readonly pool: Pool, options: { writable?: boolean } = {}) {
    this.writable = options.writable === true;
  }
  private get db() { return this.context.getStore() ?? this.pool; }
  private decode(row: { payload: unknown; checksum: string; revision: string | number } | undefined): Control {
    if (!row) throw new ApiError(503, 'NOT_PROVISIONED', '운영 초기 설정이 필요합니다.');
    try {
      const value = controlSchema.parse(row.payload);
      if (hash(value) !== row.checksum || value.revision !== Number(row.revision)) throw new Error('integrity');
      return value;
    } catch { throw new ApiError(503, 'STORAGE_INVALID', '원격 제어 JSON의 형식 또는 체크섬을 확인하지 못했습니다.'); }
  }
  async control(): Promise<Control> {
    return this.decode((await this.db.query('SELECT payload, checksum, revision FROM cashbook.control WHERE id=1')).rows[0]);
  }
  async initialize(value: Control) {
    const state = controlSchema.parse(value);
    if (state.transactionRefs.length) throw new ApiError(422, 'INITIAL_REFERENCES', '최초 설정은 거래가 없는 자료로 시작하세요. 기존 자료는 백업 검증·복원으로 이전하세요.');
    const result = await this.pool.query('INSERT INTO cashbook.control (id,revision,payload,checksum) VALUES (1,$1,$2::json,$3) ON CONFLICT (id) DO NOTHING RETURNING id', [state.revision, JSON.stringify(state), hash(state)]);
    if (result.rowCount !== 1) throw new ApiError(409, 'ALREADY_PROVISIONED', '이미 초기화된 저장소입니다. 기존 자료를 덮어쓰지 않았습니다.');
    return state;
  }
  async updateControl(expected: number, change: (value: Control) => Control) { return this.commit(change, expected); }
  async commitLedger(change: (value: Control) => Control | Promise<Control>) { return this.commit(change); }
  private async commit(change: (value: Control) => Control | Promise<Control>, expected?: number): Promise<Control> {
    if (!this.writable) throw new ApiError(503, 'WRITE_NOT_VERIFIED', '운영 쓰기 검수 전에는 자료를 변경할 수 없습니다.');
    if (this.context.getStore()) throw new ApiError(500, 'NESTED_COMMIT', '중첩 저장은 허용하지 않습니다.');
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='8s'");
      return await this.context.run(client, async () => {
        const current = this.decode((await client.query('SELECT payload,checksum,revision FROM cashbook.control WHERE id=1 FOR UPDATE')).rows[0]);
        if (expected !== undefined && current.revision !== expected) throw new ApiError(409, 'VERSION_CONFLICT', '다른 사용자가 자료를 변경했습니다. 새로 조회한 뒤 다시 저장하세요.');
        const candidate = controlSchema.parse(await change(structuredClone(current)));
        if (expected === undefined && hash(candidate) === hash(current)) {
          await client.query('COMMIT'); return current;
        }
        const next = controlSchema.parse({ ...candidate, revision: current.revision + 1 });
        // Confirm every newly published immutable reference inside the transaction.
        const old = new Set(current.transactionRefs.map(r => `${r.id}:${r.version}:${r.hash}`));
        for (const ref of next.transactionRefs) if (!old.has(`${ref.id}:${ref.version}:${ref.hash}`)) await this.readTransaction(ref);
        await client.query('INSERT INTO cashbook.snapshots (revision,payload,checksum) VALUES ($1,$2::json,$3)', [current.revision, JSON.stringify(current), hash(current)]);
        await client.query('UPDATE cashbook.control SET revision=$1,payload=$2::json,checksum=$3 WHERE id=1', [next.revision, JSON.stringify(next), hash(next)]);
        await client.query('COMMIT');
        return next;
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      if (error instanceof ApiError || error instanceof z.ZodError) throw error;
      const code = (error as { code?: string }).code;
      if (['55P03', '57014', '40P01', '40001'].includes(code ?? '')) throw new ApiError(409, 'STORAGE_BUSY', '다른 저장 작업과 충돌했습니다. 최신 자료를 조회한 뒤 다시 시도하세요.');
      // A connection failure during COMMIT can have an unknown outcome. Never auto-retry.
      throw new ApiError(503, 'STORAGE_COMMIT_UNCONFIRMED', '저장 결과를 확인하지 못했습니다. 재조회하여 반영 여부를 확인하세요. 자동 재저장하지 않습니다.');
    } finally { client.release(broken); }
  }
  async putTransaction(value: Transaction): Promise<TransactionRef> {
    if (!this.context.getStore()) throw new ApiError(503, 'TRANSACTION_REQUIRED', '거래 객체는 회계 저장 트랜잭션 안에서만 변경할 수 있습니다.');
    const tx = transactionSchema.parse(value), ref = { id: tx.id, departmentId: tx.departmentId, version: tx.version, hash: hash(tx) };
    await this.db.query('INSERT INTO cashbook.transactions (department_id,id,version,hash,payload) VALUES ($1,$2,$3,$4,$5::json) ON CONFLICT DO NOTHING', [ref.departmentId, ref.id, ref.version, ref.hash, JSON.stringify(tx)]);
    await this.readTransaction(ref);
    return ref;
  }
  async readTransaction(value: TransactionRef): Promise<Transaction> {
    const ref = transactionRefSchema.parse(value);
    try {
      const row = (await this.db.query('SELECT payload FROM cashbook.transactions WHERE department_id=$1 AND id=$2 AND version=$3 AND hash=$4', [ref.departmentId, ref.id, ref.version, ref.hash])).rows[0];
      const tx = transactionSchema.parse(row?.payload);
      if (hash(tx) !== ref.hash || tx.id !== ref.id || tx.departmentId !== ref.departmentId || tx.version !== ref.version || (tx.status === 'DELETED' && (!tx.deletedAt || !tx.deletedBy || !tx.deletionReason))) throw new Error('integrity');
      return tx;
    } catch { throw new ApiError(503, 'TRANSACTION_INVALID', '원격 거래 JSON의 형식 또는 해시를 검증하지 못했습니다.'); }
  }
  async readTransactions(values: TransactionRef[]): Promise<Transaction[]> {
    const refs = z.array(transactionRefSchema).parse(values);
    if (!refs.length) return [];
    try {
      // One ordered query, including when a business transaction owns one client.
      const result = await this.db.query(`SELECT t.payload FROM json_array_elements($1::json) WITH ORDINALITY AS r(ref,n)
        LEFT JOIN cashbook.transactions t ON t.department_id=(r.ref->>'departmentId')::uuid
          AND t.id=(r.ref->>'id')::uuid AND t.version=(r.ref->>'version')::bigint AND t.hash=r.ref->>'hash'
        ORDER BY r.n`, [JSON.stringify(refs)]);
      return refs.map((ref, i) => {
        const tx = transactionSchema.parse(result.rows[i]?.payload);
        if (hash(tx) !== ref.hash || tx.id !== ref.id || tx.departmentId !== ref.departmentId || tx.version !== ref.version || (tx.status === 'DELETED' && (!tx.deletedAt || !tx.deletedBy || !tx.deletionReason))) throw new Error('integrity');
        return tx;
      });
    } catch { throw new ApiError(503, 'TRANSACTION_INVALID', '원격 거래 JSON의 형식 또는 해시를 검증하지 못했습니다.'); }
  }
  async session(key: string): Promise<Session | null> {
    sessionKey.parse(key);
    const row = (await this.pool.query('SELECT payload FROM cashbook.sessions WHERE key=$1', [key])).rows[0];
    if (!row) return null;
    try { return sessionSchema.parse(row.payload); }
    catch { throw new ApiError(503, 'SESSION_STORE_INVALID', '세션 저장 형식을 확인하지 못했습니다.'); }
  }
  async putSession(key: string, value: Session) {
    sessionKey.parse(key); const session = sessionSchema.parse(value);
    await this.pool.query('INSERT INTO cashbook.sessions (key,payload,expires_at) VALUES ($1,$2::json,$3) ON CONFLICT (key) DO UPDATE SET payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at', [key, JSON.stringify(session), new Date(session.expiresAt)]);
  }
  async deleteSession(key: string) { sessionKey.parse(key); await this.pool.query('DELETE FROM cashbook.sessions WHERE key=$1', [key]); }
  async saveBackup(contents: string) {
    if (!this.context.getStore()) throw new ApiError(503, 'TRANSACTION_REQUIRED', '복원 전 사본은 회계 트랜잭션 안에서만 만들 수 있습니다.');
    const id = randomUUID(), checksum = createHash('sha256').update(contents).digest('hex');
    // Separate committed connection: recovery copy survives a later business rollback.
    // Pool must have >=2 connections. No control-row lock is requested here.
    const result = await this.pool.query('INSERT INTO cashbook.backups (id,contents,checksum) VALUES ($1,$2,$3) RETURNING contents,checksum', [id, contents, checksum]);
    if (result.rows[0]?.contents !== contents || result.rows[0]?.checksum !== checksum) throw new ApiError(503, 'BACKUP_FAILED', '복원 전 사본을 검증하지 못했습니다.');
    return `${id}.json`;
  }
}
