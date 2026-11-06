import { z } from 'zod';
import { themes } from '../shared/theme';

const text = (max: number) => z.string().trim().min(1).max(max);
export const userSchema = z.object({
  id: z.uuid(), subject: text(255), loginId: text(80).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: text(80), role: z.enum(['ADMIN', 'ACCOUNTANT']),
  status: z.enum(['ACTIVE', 'DISABLED']), createdAt: z.iso.datetime(),
  theme: z.enum(themes).optional(),
}).strict();
export const departmentSchema = z.object({
  id: z.uuid(), code: text(30), name: text(100),
  status: z.enum(['ACTIVE', 'INACTIVE']), createdAt: z.iso.datetime(),
  managementPeriod: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'),
}).strict();
export const dateSchema = z.iso.date();
export const assignmentSchema = z.object({
  id: z.uuid(), userId: z.uuid(), departmentId: z.uuid(), validFrom: dateSchema,
  validTo: dateSchema.nullable(), assignedBy: z.uuid(), reason: text(500),
}).strict().refine(a => !a.validTo || a.validTo >= a.validFrom);
export const accountSchema = z.object({
  id: z.uuid(), departmentId: z.uuid(), code: text(30), name: text(100),
  type: z.enum(['INCOME', 'EXPENSE']), sortOrder: z.number().int().min(0).max(999999),
  status: z.enum(['ACTIVE', 'INACTIVE']),
}).strict();
export const auditSchema = z.object({
  id: z.uuid(), actorUserId: z.uuid(), departmentId: z.uuid().nullable(),
  entityType: z.enum(['USER', 'DEPARTMENT', 'ACCOUNT', 'ASSIGNMENT', 'STORAGE', 'TRANSACTION', 'OPENING_BALANCE']).optional(), entityId: z.string().optional(),
  action: z.enum(['ASSIGNMENT_REPLACED', 'USER_CREATED', 'USER_UPDATED', 'DEPARTMENT_CREATED', 'DEPARTMENT_UPDATED', 'ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'STORAGE_RESTORED', 'TRANSACTION_CREATED', 'TRANSACTION_UPDATED', 'TRANSACTION_DELETED', 'OPENING_BALANCE_SET']),
  occurredAt: z.iso.datetime(), reason: text(500), before: z.unknown(), after: z.unknown(),
}).strict();
export const transactionRefSchema = z.object({ id: z.uuid(), departmentId: z.uuid(), version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const openingBalanceSchema = z.object({ id: z.uuid(), departmentId: z.uuid(), date: dateSchema, amount: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), createdBy: z.uuid(), createdAt: z.iso.datetime(), updatedBy: z.uuid(), updatedAt: z.iso.datetime() }).strict();
export const closingSchema = z.object({ id: z.uuid(), departmentId: z.uuid(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), status: z.enum(['OPEN', 'CLOSED']) }).strict();
export const controlSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(),
  users: z.array(userSchema), departments: z.array(departmentSchema),
  assignments: z.array(assignmentSchema), accounts: z.array(accountSchema).default([]), audit: z.array(auditSchema),
  transactionRefs: z.array(transactionRefSchema).default([]), openingBalances: z.array(openingBalanceSchema).default([]), closings: z.array(closingSchema).default([]),
}).strict().superRefine((s, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const unique = (values: string[]) => new Set(values).size === values.length;
  for (const values of [s.users.map(x => x.id), s.users.map(x => x.subject), s.users.map(x => x.loginId.toLowerCase()), s.departments.map(x => x.id), s.departments.map(x => x.code.toLowerCase()), s.assignments.map(x => x.id), s.accounts.map(x => x.id), s.accounts.map(x => `${x.departmentId}:${x.code.toLowerCase()}`), s.audit.map(x => x.id)]) {
    if (!unique(values)) issue('중복 식별자 또는 코드');
  }
  for (const a of s.assignments) {
    if (!s.users.some(u => u.id === a.userId) || !s.users.some(u => u.id === a.assignedBy) || !s.departments.some(d => d.id === a.departmentId)) issue('배정 참조 오류');
  }
  for (const a of s.accounts) if (!s.departments.some(d => d.id === a.departmentId)) issue('계정 부서 참조 오류');
  for (const values of [s.transactionRefs.map(x => x.id), s.openingBalances.map(x => x.id), s.openingBalances.map(x => x.departmentId), s.closings.map(x => x.id), s.closings.map(x => `${x.departmentId}:${x.period}`)]) if (!unique(values)) issue('중복 거래/기초잔액/마감');
  for (const record of [...s.transactionRefs, ...s.openingBalances, ...s.closings]) if (!s.departments.some(d => d.id === record.departmentId)) issue('장부 부서 참조 오류');
  for (const record of s.openingBalances) if (!s.users.some(u => u.id === record.createdBy) || !s.users.some(u => u.id === record.updatedBy)) issue('기초잔액 작성자 참조 오류');
  for (const a of s.audit) if (!s.users.some(u => u.id === a.actorUserId) || (a.departmentId !== null && !s.departments.some(d => d.id === a.departmentId))) issue('감사 참조 오류');
  if (!s.users.some(u => u.role === 'ADMIN' && u.status === 'ACTIVE')) issue('활성 관리자 필요');
});
export type User = z.infer<typeof userSchema>;
export type Department = z.infer<typeof departmentSchema>;
export type Control = z.infer<typeof controlSchema>;
export type Account = z.infer<typeof accountSchema>;
const revision = z.number().int().positive();
const reason = text(500).min(2);
export const assignmentInput = z.object({ departmentId: z.uuid(), userIds: z.array(z.uuid()).max(20), effectiveDate: dateSchema, reason, expectedRevision: revision }).strict();
export const userCreateInput = userSchema.pick({ loginId: true, displayName: true, role: true, status: true }).extend({ subject: text(255).optional(), reason, expectedRevision: revision }).strict();
export const userUpdateInput = userSchema.pick({ displayName: true, role: true, status: true }).extend({ id: z.uuid(), reason, expectedRevision: revision }).strict();
export const departmentCreateInput = departmentSchema.pick({ code: true, name: true, status: true, managementPeriod: true }).extend({ managementPeriod: z.enum(['MONTHLY','YEARLY']).default('YEARLY'), reason, expectedRevision: revision }).strict();
export const departmentUpdateInput = departmentCreateInput.extend({ id: z.uuid(), managementPeriod: z.enum(['MONTHLY','YEARLY']).optional() }).strict();
export const accountCreateInput = accountSchema.omit({ id: true }).extend({ reason, expectedRevision: revision }).strict();
export const accountUpdateInput = accountCreateInput.extend({ id: z.uuid() }).strict();
export const transactionSchema = z.object({
  id: z.uuid(), departmentId: z.uuid(), date: dateSchema, accountId: z.uuid(), type: z.enum(['INCOME', 'EXPENSE']), description: text(500),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), remark: z.string().max(1000),
  createdBy: z.uuid(), createdAt: z.iso.datetime(), updatedBy: z.uuid(), updatedAt: z.iso.datetime(), version: z.number().int().positive(), status: z.enum(['ACTIVE', 'DELETED']),
  deletedBy: z.uuid().optional(), deletedAt: z.iso.datetime().optional(), deletionReason: text(500).optional(),
}).strict();
export type Transaction = z.infer<typeof transactionSchema>;
export type TransactionRef = z.infer<typeof transactionRefSchema>;
const transactionFields = transactionSchema.pick({ departmentId: true, date: true, accountId: true, type: true, description: true, amount: true, remark: true });
export const transactionCreateInput = transactionFields.extend({ requestId: z.uuid(), reason: reason.default('거래 등록') }).strict();
export const transactionUpdateInput = transactionFields.extend({ id: z.uuid(), expectedVersion: revision, reason }).strict();
export const transactionDeleteInput = z.object({ id: z.uuid(), departmentId: z.uuid(), expectedVersion: revision, reason }).strict();
export const openingBalanceInput = openingBalanceSchema.pick({ departmentId: true, date: true, amount: true }).extend({ expectedRevision: revision, reason }).strict();
