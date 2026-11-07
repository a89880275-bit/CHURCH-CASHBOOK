import { z } from 'zod';
import { dateSchema, type Control, type Department, type Transaction, type User } from './schema';
import { type Repository } from './store';
import { requireAdmin, requireDepartment } from './policy';
import { periodBalances, readDepartment, safeNumber, totals } from './ledger';
import { periodRange } from '../shared/period';

type Scope = { department: Department; transactions: Transaction[] }[];
const scopeQuery = z.object({ departmentId: z.uuid().optional(), year: z.coerce.number().int().min(1).max(9999) }).strict();
async function loadScope(repo: Repository, state: Control, user: User, departmentId?: string): Promise<Scope> {
  if (departmentId) requireDepartment(state, user, departmentId); else requireAdmin(user);
  const result: Scope = [];
  for (const department of state.departments.filter(d => !departmentId || d.id === departmentId)) {
    result.push({ department, transactions: await readDepartment(repo, state, department.id) });
  }
  return result;
}
function summary(state: Control, scope: Scope, from: string, to: string) {
  let income = 0n, expense = 0n, carry = 0n, end = 0n, count = 0;
  const missingCarry: string[] = [], missingBalance: string[] = [];
  for (const { department, transactions } of scope) {
    const sums = totals(transactions.filter(t => t.date >= from && t.date <= to));
    income += BigInt(sums.income); expense += BigInt(sums.expense); count += sums.count;
    const balances = periodBalances(state, department.id, transactions, from, to);
    if (balances.carryForward === null) missingCarry.push(department.name); else carry += BigInt(balances.carryForward);
    if (balances.balance === null) missingBalance.push(department.name); else end += BigInt(balances.balance);
  }
  return { from, to, income: safeNumber(income), expense: safeNumber(expense), difference: safeNumber(income - expense), count,
    carryForward: scope.length > 0 && missingCarry.length === 0 ? safeNumber(carry) : null,
    balance: scope.length > 0 && missingBalance.length === 0 ? safeNumber(end) : null, missingCarry, missingBalance };
}
function monthly(state: Control, scope: Scope, year: number) {
  return Array.from({ length: 12 }, (_, index) => {
    const range = periodRange('MONTHLY', year, index + 1);
    const period = range.from.slice(0,7);
    const closedDepartments = scope.filter(s => state.closings.some(c => c.departmentId === s.department.id && c.period === period && c.status === 'CLOSED')).length;
    return { month: index + 1, ...summary(state, scope, range.from, range.to), closedDepartments, departmentCount: scope.length,
      closingStatus: scope.length === 0 ? 'EMPTY' : closedDepartments === scope.length ? 'CLOSED' : closedDepartments > 0 ? 'PARTIAL' : 'OPEN' };
  });
}
function departmentRows(state: Control, scope: Scope, from: string, to: string) {
  return scope.map(s => ({ departmentId: s.department.id, departmentName: s.department.name, departmentCode: s.department.code, status: s.department.status, ...summary(state, [s], from, to) }));
}
function accountMatrix(state: Control, scope: Scope, year: number, type: 'INCOME' | 'EXPENSE') {
  const ids = new Set(scope.map(s => s.department.id));
  const accounts = state.accounts.filter(a => ids.has(a.departmentId) && a.type === type).sort((a,b) => a.departmentId.localeCompare(b.departmentId) || a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  const values = new Map(accounts.map(a => [a.id, Array<bigint>(12).fill(0n)]));
  for (const s of scope) for (const transaction of s.transactions) {
    if (transaction.status !== 'ACTIVE' || transaction.type !== type || transaction.date.slice(0,4) !== String(year).padStart(4,'0')) continue;
    values.get(transaction.accountId)![Number(transaction.date.slice(5,7)) - 1] += BigInt(transaction.amount);
  }
  const rows = accounts.map(account => ({ ...account, departmentName: scope.find(s => s.department.id === account.departmentId)!.department.name,
    months: values.get(account.id)!.map(safeNumber), total: safeNumber(values.get(account.id)!.reduce((a,b) => a + b, 0n)) }));
  const monthlyTotals = Array.from({ length: 12 }, (_, month) => safeNumber(rows.reduce((sum,row) => sum + BigInt(row.months[month]), 0n)));
  return { year, type, rows, monthlyTotals, grandTotal: safeNumber(monthlyTotals.reduce((sum,amount) => sum + BigInt(amount), 0n)) };
}
const json = (data: unknown) => Response.json({ success: true, data });
export async function handleReports({ path, method, url, state, user, repo }: { path: string; method: string; url: URL; state: Control; user: User; repo: Repository }): Promise<Response | null> {
  if (method !== 'GET' || !['/api/reports/monthly','/api/reports/account-monthly','/api/reports/annual','/api/reports/departments','/api/reports/dashboard'].includes(path)) return null;
  const raw = Object.fromEntries(url.searchParams);
  if (path === '/api/reports/departments') {
    requireAdmin(user);
    const input = scopeQuery.extend({ month: z.coerce.number().int().min(1).max(12).optional() }).parse(raw);
    const scope = await loadScope(repo,state,user,input.departmentId);
    const range = periodRange(input.month ? 'MONTHLY' : 'YEARLY',input.year,input.month ?? 1);
    return json({ year: input.year, month: input.month ?? null, ...range, rows: departmentRows(state,scope,range.from,range.to), summary: summary(state,scope,range.from,range.to) });
  }
  if (path === '/api/reports/account-monthly') {
    const input = scopeQuery.extend({ type: z.enum(['INCOME','EXPENSE']) }).parse(raw);
    const scope = await loadScope(repo,state,user,input.departmentId),range = periodRange('YEARLY',input.year);
    return json({ ...accountMatrix(state,scope,input.year,input.type), summary:summary(state,scope,range.from,range.to) });
  }
  if (path === '/api/reports/dashboard') {
    const input = scopeQuery.extend({ from: dateSchema, to: dateSchema }).refine(q => q.from <= q.to && q.from.slice(0,4) === String(q.year).padStart(4,'0') && q.to.slice(0,4) === String(q.year).padStart(4,'0')).parse(raw);
    const scope = await loadScope(repo,state,user,input.departmentId);
    const rangeRows = scope.flatMap(s => s.transactions.filter(t => t.status === 'ACTIVE' && t.date >= input.from && t.date <= input.to).map(t => ({ ...t, departmentName: s.department.name, accountName: state.accounts.find(a => a.id === t.accountId)!.name, accountCode: state.accounts.find(a => a.id === t.accountId)!.code, createdByName: state.users.find(u => u.id === t.createdBy)!.displayName })));
    const expenseMap = new Map<string,{ accountId: string; departmentId: string; departmentName: string; code: string; name: string; amount: bigint }>();
    for (const t of rangeRows.filter(t => t.type === 'EXPENSE')) {
      const item = expenseMap.get(t.accountId) ?? { accountId:t.accountId,departmentId:t.departmentId,departmentName:t.departmentName,code:t.accountCode,name:t.accountName,amount:0n };
      item.amount += BigInt(t.amount); expenseMap.set(t.accountId,item);
    }
    const topExpenses = Array.from(expenseMap.values()).map(item => ({ ...item, amount:safeNumber(item.amount) })).sort((a,b) => b.amount - a.amount || a.code.localeCompare(b.code)).slice(0,5);
    const recentTransactions = rangeRows.sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0,10);
    return json({ ...input, summary:summary(state,scope,input.from,input.to), monthly:monthly(state,scope,input.year), recentTransactions, topExpenses, departmentCount:scope.length });
  }
  const input = scopeQuery.parse(raw), scope = await loadScope(repo,state,user,input.departmentId);
  const range = periodRange('YEARLY',input.year);
  const rows = monthly(state,scope,input.year);
  if (path === '/api/reports/monthly') return json({ year:input.year, rows, summary:summary(state,scope,range.from,range.to) });
  const annualClosed=scope.filter(s=>(state.annualClosings??[]).some(c=>c.departmentId===s.department.id&&c.period===String(input.year).padStart(4,'0')&&c.status==='CLOSED')).length;
  const annualStatus=!scope.length?'EMPTY':annualClosed===scope.length?'CLOSED':annualClosed?'PARTIAL':'OPEN';
  return json({ year:input.year, annualStatus, ...range, summary:summary(state,scope,range.from,range.to), monthly:rows, departments:departmentRows(state,scope,range.from,range.to), closedMonths:rows.filter(r => r.closingStatus === 'CLOSED').length, departmentCount:scope.length });
}
