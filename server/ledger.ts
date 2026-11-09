import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dateSchema, openingBalanceInput, transactionCreateInput, transactionUpdateInput, transactionDeleteInput, type Control, type Transaction, type User } from './schema';
import { ApiError, type Repository } from './store';
import { requireAdmin, requireDepartment } from './policy';
import { workbook } from './xlsx';
import { ledgerPrint } from './ledger-print';

const json = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
export function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new ApiError(422, 'AMOUNT_OVERFLOW', '금액 합계가 안전하게 처리할 수 있는 범위를 초과합니다.');
  return Number(value);
}
function writer(state: Control, subject: string, departmentId: string) {
  const user = state.users.find(u => u.subject === subject && u.status === 'ACTIVE');
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  requireDepartment(state, user, departmentId);
  if (!state.departments.some(d => d.id === departmentId && d.status === 'ACTIVE')) throw new ApiError(409, 'DEPARTMENT_INACTIVE', '사용 중지된 부서는 거래를 변경할 수 없습니다.');
  return user;
}
function unlocked(state: Control, departmentId: string, ...dates: string[]) {
  if (state.closings.some(c => c.departmentId === departmentId && c.status === 'CLOSED' && dates.some(date => date.slice(0, 7) === c.period))) throw new ApiError(409, 'PERIOD_CLOSED', '마감된 월의 거래는 변경할 수 없습니다. 관리자 마감 해제 절차가 필요합니다.');
}
function checkTransaction(state: Control, tx: Transaction) {
  const account = state.accounts.find(a => a.id === tx.accountId && a.departmentId === tx.departmentId);
  if (!account) throw new ApiError(422, 'ACCOUNT_DEPARTMENT_MISMATCH', '해당 부서에 속한 계정을 선택해 주세요.');
  if(account.treatment==='OPENING_BALANCE')throw new ApiError(422,'OPENING_BALANCE_ONLY','전년이월은 일반 수입으로 등록할 수 없습니다. 관리자의 기초잔액 기능을 사용하세요.');
  if(account.treatment==='REFUND_REVIEW')throw new ApiError(422,'REFUND_REVIEW_REQUIRED','환불금은 원거래 취소·지출 환입 여부를 먼저 확인해야 합니다. 중복 수입 등록을 차단합니다.');
  if (account.status !== 'ACTIVE') throw new ApiError(422, 'ACCOUNT_INACTIVE', '활성 계정을 선택해 주세요.');
  if (account.type !== tx.type) throw new ApiError(422, 'ACCOUNT_TYPE_MISMATCH', '계정과 거래의 수입·지출 유형이 일치하지 않습니다.');
  const opening = state.openingBalances.find(b => b.departmentId === tx.departmentId);
  if (opening && tx.date < opening.date) throw new ApiError(422, 'BEFORE_OPENING_DATE', '기초잔액 적용일 이전에는 거래를 등록할 수 없습니다.');
}
function audit(state: Control, user: User, tx: Transaction, before: unknown, action: 'TRANSACTION_CREATED' | 'TRANSACTION_UPDATED' | 'TRANSACTION_DELETED', reason: string) {
  state.audit.push({ id: randomUUID(), actorUserId: user.id, departmentId: tx.departmentId, entityType: 'TRANSACTION', entityId: tx.id, action, before, after: tx, occurredAt: tx.updatedAt, reason });
}
export async function readDepartment(repo: Repository, state: Control, departmentId: string) {
  if (!repo.readTransaction) throw new ApiError(503, 'LEDGER_STORE_UNAVAILABLE', '이 저장소의 거래 읽기 기능이 아직 검증되지 않았습니다.');
  const refs = state.transactionRefs.filter(r => r.departmentId === departmentId);
  if (refs.length > 20000) throw new ApiError(503, 'LEDGER_CAPACITY', '부서 거래가 현재 검증한 처리 한도를 초과했습니다. 저장소 확장이 필요합니다.');
  const rows: Transaction[] = [];
  // Bound concurrent filesystem reads; never treat directory listing/orphan objects as committed records.
  for (let i = 0; i < refs.length; i += 32) {
    const batch = refs.slice(i, i + 32);
    rows.push(...await (repo.readTransactions ? repo.readTransactions(batch) : Promise.all(batch.map(r => repo.readTransaction!(r)))));
  }
  for (const row of rows) {
    if (!state.accounts.some(a => a.id === row.accountId && a.departmentId === row.departmentId && a.type === row.type) || !state.users.some(u => u.id === row.createdBy) || !state.users.some(u => u.id === row.updatedBy)) throw new ApiError(503, 'TRANSACTION_REFERENCE_INVALID', '거래의 계정 또는 작성자 참조를 확인할 수 없습니다.');
  }
  return rows;
}
export function totals(rows: Transaction[]) {
  const active = rows.filter(r => r.status === 'ACTIVE');
  const income = active.filter(r => r.type === 'INCOME').reduce((sum, r) => sum + BigInt(r.amount), 0n);
  const expense = active.filter(r => r.type === 'EXPENSE').reduce((sum, r) => sum + BigInt(r.amount), 0n);
  return { income: safeNumber(income), expense: safeNumber(expense), difference: safeNumber(income - expense), count: active.length };
}
export function periodBalances(state: Control, departmentId: string, rows: Transaction[], from: string, to: string) {
  const opening = state.openingBalances.find(b => b.departmentId === departmentId) ?? null;
  const at = (date: string, inclusive: boolean) => {
    if (!opening || opening.date > date) return null;
    const change = rows.filter(t => t.status === 'ACTIVE' && t.date >= opening.date && (inclusive ? t.date <= date : t.date < date))
      .reduce((sum, t) => sum + (t.type === 'INCOME' ? BigInt(t.amount) : -BigInt(t.amount)), 0n);
    return safeNumber(BigInt(opening.amount) + change);
  };
  return { opening, carryForward: at(from, false), balance: at(to, true) };
}
function verifyArithmetic(state: Control, departmentId: string, rows: Transaction[]) {
  totals(rows);
  const opening = state.openingBalances.find(b => b.departmentId === departmentId);
  if (opening) {
    let balance = BigInt(opening.amount);
    for (const row of rows.filter(r => r.status === 'ACTIVE').sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
      if (row.date < opening.date) throw new ApiError(422, 'OPENING_AFTER_TRANSACTIONS', '기존 거래일보다 늦은 날짜로 기초잔액을 적용할 수 없습니다.');
      balance += row.type === 'INCOME' ? BigInt(row.amount) : -BigInt(row.amount); safeNumber(balance);
    }
  }
}
const querySchema = z.object({
  departmentId: z.uuid(), from: dateSchema.default('0001-01-01'), to: dateSchema.default('9999-12-31'),
  type: z.enum(['INCOME', 'EXPENSE']).optional(), accountId: z.uuid().optional(), keyword: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['date_desc', 'date_asc']).default('date_desc'), includeDeleted: z.enum(['0', '1']).default('0'),
}).strict().refine(q => q.from <= q.to, { message: '조회 시작일과 종료일을 확인해 주세요.' });

export async function handleLedger(args: { path: string; method: string; url: URL; state: Control; user: User; repo: Repository; body: () => Promise<unknown> }): Promise<Response | null> {
  const { path, method, url, state, user, repo } = args;
  if (path === '/api/reports/summary' && method === 'GET') {
    const input = z.object({ departmentId: z.uuid().optional(), from: dateSchema, to: dateSchema }).strict().refine(q => q.from <= q.to).parse(Object.fromEntries(url.searchParams));
    if (input.departmentId) requireDepartment(state, user, input.departmentId); else requireAdmin(user);
    const departments = state.departments.filter(d => !input.departmentId || d.id === input.departmentId);
    let income = 0n, expense = 0n, carry = 0n, end = 0n;
    const missingCarry: string[] = [], missingBalance: string[] = [];
    for (const d of departments) {
      const rows = await readDepartment(repo, state, d.id);
      const sum = totals(rows.filter(t => t.date >= input.from && t.date <= input.to));
      income += BigInt(sum.income); expense += BigInt(sum.expense);
      const balances = periodBalances(state, d.id, rows, input.from, input.to);
      if (balances.carryForward === null) missingCarry.push(d.name); else carry += BigInt(balances.carryForward);
      if (balances.balance === null) missingBalance.push(d.name); else end += BigInt(balances.balance);
    }
    return json({ ...input, departmentCount: departments.length, income: safeNumber(income), expense: safeNumber(expense), difference: safeNumber(income - expense), carryForward: departments.length && !missingCarry.length ? safeNumber(carry) : null, balance: departments.length && !missingBalance.length ? safeNumber(end) : null, missingCarry, missingBalance });
  }
  if (path === '/api/transactions/detail' && method === 'GET') {
    const input = z.object({ departmentId: z.uuid(), id: z.uuid() }).strict().parse(Object.fromEntries(url.searchParams));
    requireDepartment(state, user, input.departmentId);
    const ref = state.transactionRefs.find(r => r.id === input.id && r.departmentId === input.departmentId);
    if (!ref) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '이 부서의 거래를 찾을 수 없습니다.');
    if (!repo.readTransaction) throw new ApiError(503, 'LEDGER_STORE_UNAVAILABLE', '거래 저장소가 아직 연결되지 않았습니다.');
    return json(await repo.readTransaction(ref));
  }
  if (path === '/api/transactions/history' && method === 'GET') {
    const input = z.object({ departmentId: z.uuid(), id: z.uuid() }).strict().parse(Object.fromEntries(url.searchParams));
    requireDepartment(state, user, input.departmentId);
    if (!state.transactionRefs.some(r => r.id === input.id && r.departmentId === input.departmentId)) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '거래를 찾을 수 없습니다.');
    return json(state.audit.filter(a => a.entityType === 'TRANSACTION' && a.entityId === input.id && a.departmentId === input.departmentId).map(a => ({ ...a, actorName: state.users.find(u => u.id === a.actorUserId)?.displayName ?? '알 수 없음' })));
  }
  if (['/api/transactions','/api/transactions/export.xlsx','/api/transactions/print'].includes(path) && method === 'GET') {
    const input = querySchema.parse(Object.fromEntries(url.searchParams));
    requireDepartment(state, user, input.departmentId);
    if (input.accountId && !state.accounts.some(a => a.id === input.accountId && a.departmentId === input.departmentId)) throw new ApiError(403, 'ACCOUNT_ACCESS_DENIED', '조회 계정이 해당 부서에 속하지 않습니다.');
    const all = await readDepartment(repo, state, input.departmentId);
    const filtered = all.filter(t => t.date >= input.from && t.date <= input.to && (input.includeDeleted === '1' || t.status === 'ACTIVE') && (!input.type || t.type === input.type) && (!input.accountId || t.accountId === input.accountId) && (!input.keyword || `${t.description} ${t.remark}`.toLocaleLowerCase().includes(input.keyword.toLocaleLowerCase())));
    filtered.sort((a,b) => (input.sort === 'date_asc' ? 1 : -1) * (a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
    const { opening, balance, carryForward } = periodBalances(state, input.departmentId, all, input.from, input.to);
    const balances=new Map<string,number>();
    if(opening){let running=BigInt(opening.amount);for(const tx of all.filter(t=>t.status==='ACTIVE'&&t.date>=opening.date).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))){running+=tx.type==='INCOME'?BigInt(tx.amount):-BigInt(tx.amount);balances.set(tx.id,safeNumber(running));}}
    if(path.endsWith('/print')){
      const sum=totals(filtered),department=state.departments.find(d=>d.id===input.departmentId)!;
      const conditions=[input.type==='INCOME'?'수입':input.type==='EXPENSE'?'지출':'전체 유형',input.accountId?`계정: ${state.accounts.find(a=>a.id===input.accountId)?.name??input.accountId}`:'전체 계정',input.keyword?`검색: ${input.keyword}`:'검색어 없음',input.includeDeleted==='1'?'삭제 이력 포함':'활성 거래',input.sort==='date_asc'?'이전 거래일순':'최신 거래일순'].join(' · ');
      const html=ledgerPrint({department:department.name,from:input.from,to:input.to,conditions,carry:carryForward,income:sum.income,expense:sum.expense,balance,rows:filtered.map(t=>({date:t.date,type:t.type==='INCOME'?'수입':'지출',account:state.accounts.find(a=>a.id===t.accountId)?.name??'',description:t.description,remark:t.remark,income:t.type==='INCOME'?t.amount:null,expense:t.type==='EXPENSE'?t.amount:null,balance:balances.get(t.id)??null,author:state.users.find(u=>u.id===t.createdBy)?.displayName??'',updated:new Date(t.updatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+` · v${t.version}`,deleted:t.status==='DELETED'}))});
      return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'"}});
    }
    if(path.endsWith('/export.xlsx')){
      const sum=totals(filtered),dept=state.departments.find(d=>d.id===input.departmentId)!;
      const rows:(string|number|null)[][]=[['부서',dept.name],['조회기간',input.from,input.to],['이월금액',carryForward],['수입 합계',sum.income,'지출 합계',sum.expense,'기간말 잔액',balance],['잔액 기준','전체 부서 거래 누적 · 검색필터 제외 · 동일 일자는 생성시각/ID 순'],['거래일','구분','계정코드','계정명','적요','수입','지출','거래 후 잔액','비고','상태','작성자']];
      for(const tx of filtered){const account=state.accounts.find(a=>a.id===tx.accountId)!;rows.push([tx.date,tx.type==='INCOME'?'수입':'지출',account.code,account.name,tx.description,tx.type==='INCOME'?tx.amount:0,tx.type==='EXPENSE'?tx.amount:0,balances.get(tx.id)??null,tx.remark,tx.status==='ACTIVE'?'활성':'삭제',state.users.find(u=>u.id===tx.createdBy)?.displayName??'']);}
      return new Response(new Uint8Array(workbook(rows)),{headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','content-disposition':`attachment; filename="ledger-${input.from}-${input.to}.xlsx"`}});
    }
    const items = filtered.slice((input.page - 1) * input.pageSize, input.page * input.pageSize).map(t => ({ ...t, runningBalance:balances.get(t.id)??null, account: state.accounts.find(a => a.id === t.accountId), createdByName: state.users.find(u => u.id === t.createdBy)?.displayName ?? '', updatedByName: state.users.find(u => u.id === t.updatedBy)?.displayName ?? '' }));
    return json({ items, total: filtered.length, page: input.page, pageSize: input.pageSize, totals: totals(filtered), carryForward, balance, openingBalance: opening, revision: state.revision, accounts: state.accounts.filter(a => a.departmentId === input.departmentId).sort((a,b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)), closedPeriods: state.closings.filter(c => c.departmentId === input.departmentId && c.status === 'CLOSED').map(c => c.period) });
  }
  if (['/api/admin/opening-balances','/api/opening-balances'].includes(path) && method === 'POST') {
    if(path.startsWith('/api/admin/')) requireAdmin(user);
    const input = openingBalanceInput.parse(await args.body());
    writer(state,user.subject,input.departmentId);
    if (!repo.writable || !repo.commitLedger) throw new ApiError(503, 'WRITE_NOT_VERIFIED', '이 저장소의 장부 변경은 아직 검증되지 않았습니다.');
    const next = await repo.commitLedger(async current => {
      const admin = writer(current, user.subject, input.departmentId);
      if(path.startsWith('/api/admin/')) requireAdmin(admin);
      const before = current.openingBalances.find(b => b.departmentId === input.departmentId) ?? null;
      if(before && admin.role!=='ADMIN') throw new ApiError(403,'OPENING_BALANCE_ADMIN_ONLY','기초잔액이 이미 등록되어 있습니다. 최초 등록 후 수정은 관리자만 가능합니다.');
      if (current.revision !== input.expectedRevision) throw new ApiError(409, 'VERSION_CONFLICT', '자료가 변경되었습니다. 재조회 후 다시 설정해 주세요.');
      if (current.closings.some(c => c.departmentId === input.departmentId && c.status === 'CLOSED' && (input.date.slice(0,7) <= c.period || (before && before.date.slice(0,7) <= c.period)))) throw new ApiError(409, 'PERIOD_CLOSED', '마감된 기간에 영향을 주는 기초잔액은 변경할 수 없습니다.');
      const now = new Date().toISOString();
      const after = { id: before?.id ?? randomUUID(), departmentId: input.departmentId, date: input.date, amount: input.amount, createdBy: before?.createdBy ?? admin.id, createdAt: before?.createdAt ?? now, updatedBy: admin.id, updatedAt: now };
      current.openingBalances = [...current.openingBalances.filter(b => b.departmentId !== input.departmentId), after];
      verifyArithmetic(current, input.departmentId, await readDepartment(repo, current, input.departmentId));
      current.audit.push({ id: randomUUID(), actorUserId: admin.id, departmentId: input.departmentId, entityType: 'OPENING_BALANCE', entityId: after.id, action: 'OPENING_BALANCE_SET', before, after, occurredAt: now, reason: input.reason });
      return current;
    });
    return json({ openingBalance: next.openingBalances.find(b => b.departmentId === input.departmentId), revision: next.revision });
  }
  if (path !== '/api/transactions' || !['POST', 'PATCH', 'DELETE'].includes(method)) return null;
  if (!repo.writable || !repo.commitLedger || !repo.putTransaction || !repo.readTransaction) throw new ApiError(503, 'WRITE_NOT_VERIFIED', '이 저장소의 거래 변경은 아직 검증되지 않았습니다.');
  const raw = await args.body();
  let transaction: Transaction, before: Transaction | null = null, reason: string, expectedVersion: number | undefined;
  if (method === 'POST') {
    const input = transactionCreateInput.parse(raw); const actor = writer(state, user.subject, input.departmentId);
    const existing = state.transactionRefs.find(r => r.id === input.requestId);
    if (existing) {
      if (existing.departmentId !== input.departmentId) throw new ApiError(409, 'REQUEST_ID_CONFLICT', '이 요청 ID는 이미 사용되었습니다.');
      const saved = await repo.readTransaction(existing);
      if (saved.createdBy === actor.id && saved.status === 'ACTIVE' && (['departmentId','date','accountId','type','description','amount','remark'] as const).every(key => saved[key] === input[key])) return json({ transaction: saved, replay: true });
      throw new ApiError(409, 'REQUEST_ID_CONFLICT', '이미 저장된 요청입니다. 목록을 재조회해 주세요.');
    }
    const now = new Date().toISOString(); reason = input.reason;
    transaction = { id: input.requestId, departmentId: input.departmentId, date: input.date, accountId: input.accountId, type: input.type, description: input.description, amount: input.amount, remark: input.remark, createdBy: actor.id, createdAt: now, updatedBy: actor.id, updatedAt: now, version: 1, status: 'ACTIVE' };
    unlocked(state, input.departmentId, input.date); checkTransaction(state, transaction);
  } else {
    const input = method === 'PATCH' ? transactionUpdateInput.parse(raw) : transactionDeleteInput.parse(raw);
    writer(state, user.subject, input.departmentId);
    const ref = state.transactionRefs.find(r => r.id === input.id && r.departmentId === input.departmentId);
    if (!ref) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '이 부서의 거래를 찾을 수 없습니다.');
    before = await repo.readTransaction(ref); expectedVersion = input.expectedVersion; reason = input.reason;
    if (before.version !== expectedVersion || before.status !== 'ACTIVE') throw new ApiError(409, 'TRANSACTION_VERSION_CONFLICT', '거래가 수정되거나 삭제되었습니다. 최신 내용을 재조회해 주세요.');
    const now = new Date().toISOString();
    transaction = method === 'PATCH' ? { ...before, ...transactionUpdateInput.parse(raw), updatedBy: user.id, updatedAt: now, version: before.version + 1 } : { ...before, status: 'DELETED', updatedBy: user.id, updatedAt: now, version: before.version + 1, deletedBy: user.id, deletedAt: now, deletionReason: input.reason };
    // Only persisted schema fields; request version/reason never enter a transaction object.
    if (method === 'PATCH') { const update = transactionUpdateInput.parse(raw); transaction = { ...before, date: update.date, accountId: update.accountId, type: update.type, description: update.description, amount: update.amount, remark: update.remark, updatedBy: user.id, updatedAt: now, version: before.version + 1 }; }
    unlocked(state, input.departmentId, before.date, transaction.date);
    if (method !== 'DELETE') checkTransaction(state, transaction);
  }
  // Write immutable objects inside the repository's business transaction/lock.
  // PostgreSQL must use the same connection for objects, manifest and audit.
  let replay = false;
  await repo.commitLedger(async current => {
    const actor = writer(current, user.subject, transaction.departmentId);
    const previous = current.transactionRefs.find(r => r.id === transaction.id);
    if (method === 'POST' && previous) {
      if (previous.departmentId !== transaction.departmentId) throw new ApiError(409, 'REQUEST_ID_CONFLICT', '이 요청 ID는 이미 사용되었습니다.');
      const saved = await repo.readTransaction!(previous);
      if (saved.createdBy !== actor.id || saved.status !== 'ACTIVE' || !(['departmentId','date','accountId','type','description','amount','remark'] as const).every(key => saved[key] === transaction[key])) throw new ApiError(409, 'REQUEST_ID_CONFLICT', '이미 저장된 요청입니다. 목록을 재조회해 주세요.');
      transaction = saved; replay = true; return current;
    }
    unlocked(current, transaction.departmentId, ...(before ? [before.date, transaction.date] : [transaction.date]));
    if (method !== 'DELETE') checkTransaction(current, transaction);
    if (method === 'POST' ? !!previous : !previous || previous.departmentId !== transaction.departmentId || previous.version !== expectedVersion) throw new ApiError(409, 'TRANSACTION_VERSION_CONFLICT', '거래가 먼저 변경되었습니다. 재조회 후 다시 시도해 주세요.');
    const ref = await repo.putTransaction!(transaction);
    current.transactionRefs = [...current.transactionRefs.filter(r => r.id !== transaction.id), ref];
    verifyArithmetic(current, transaction.departmentId, await readDepartment(repo, current, transaction.departmentId));
    audit(current, actor, transaction, before, method === 'POST' ? 'TRANSACTION_CREATED' : method === 'PATCH' ? 'TRANSACTION_UPDATED' : 'TRANSACTION_DELETED', reason);
    return current;
  });
  return json({ transaction, ...(replay ? { replay: true } : {}) }, method === 'POST' && !replay ? 201 : 200);
}
