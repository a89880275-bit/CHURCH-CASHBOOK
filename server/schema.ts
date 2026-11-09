import { z } from 'zod';
import { themes } from '../shared/theme';
import { standardAccountSchema, normalizeAccountText } from '../shared/account-catalog';

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
  standardAccountId:z.uuid().optional(),standardAccountVersion:z.number().int().positive().optional(),
  majorCategory:text(80).optional(),minorCategory:text(80).optional(),importedAt:z.iso.datetime().optional(),importedBy:z.uuid().optional(),
  treatment:z.enum(['NORMAL','OPENING_BALANCE','REFUND_REVIEW']).optional(),
}).strict();
export const auditSchema = z.object({
  id: z.uuid(), actorUserId: z.uuid(), departmentId: z.uuid().nullable(),
  entityType: z.enum(['STANDARD_ACCOUNT', 'USER', 'DEPARTMENT', 'ACCOUNT', 'ASSIGNMENT', 'STORAGE', 'TRANSACTION', 'OPENING_BALANCE', 'CLOSING']).optional(), entityId: z.string().optional(),
  action: z.enum(['TEMPLATE_INSTALLED','TEMPLATE_UPDATED','STANDARD_ACCOUNT_CREATED','STANDARD_ACCOUNT_UPDATED','STANDARD_CATALOG_RESTORED','ACCOUNT_IMPORTED','ACCOUNT_SOURCE_LINKED','INVITATION_UPDATED', 'ASSIGNMENT_REPLACED', 'USER_CREATED', 'USER_UPDATED', 'DEPARTMENT_CREATED', 'DEPARTMENT_UPDATED', 'ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'STORAGE_RESTORED', 'TRANSACTION_CREATED', 'TRANSACTION_UPDATED', 'TRANSACTION_DELETED', 'OPENING_BALANCE_SET', 'MONTH_CLOSED', 'MONTH_REOPENED', 'YEAR_CLOSED', 'YEAR_REOPENED']),
  occurredAt: z.iso.datetime(), reason: text(500), before: z.unknown(), after: z.unknown(),
}).strict();
export const transactionRefSchema = z.object({ id: z.uuid(), departmentId: z.uuid(), version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const openingBalanceSchema = z.object({ id: z.uuid(), departmentId: z.uuid(), date: dateSchema, amount: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), createdBy: z.uuid(), createdAt: z.iso.datetime(), updatedBy: z.uuid(), updatedAt: z.iso.datetime() }).strict();
const closingSummary=z.object({income:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),expense:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),balance:z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),carryForward:z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),count:z.number().int().min(0)}).strict();
export const closingSchema = z.object({ id: z.uuid(), departmentId: z.uuid(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), status: z.enum(['OPEN', 'CLOSED']),updatedBy:z.uuid().optional(),updatedAt:z.iso.datetime().optional(),reason:text(500).optional(),summary:closingSummary.optional() }).strict();
export const annualClosingSchema=closingSchema.extend({period:z.string().regex(/^(?!0000)\d{4}$/)});
export const invitationSchema = z.object({
  id: z.uuid(), email: z.email().max(254), displayName: text(80), departmentId: z.uuid(), createdBy: z.uuid(), createdAt: z.iso.datetime(),
  status: z.enum(['CREATING', 'CREATE_FAILED', 'REVIEW_REQUIRED', 'ACCOUNT_READY', 'MAIL_REQUESTING', 'MAIL_ACCEPTED', 'MAIL_FAILED']),
  subject: text(255).optional(), userId: z.uuid().optional(), operationId: z.uuid(), leaseUntil: z.number().finite(),
  mailAttempts: z.array(z.number().finite()).max(100), errorCode: z.enum(['CREATE_FAILED', 'CREATE_UNKNOWN', 'EXISTING_ACCOUNT', 'MAIL_FAILED', 'MAIL_UNKNOWN']).optional(),
}).strict();
export const controlSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(),
  users: z.array(userSchema), departments: z.array(departmentSchema),
  assignments: z.array(assignmentSchema), accounts: z.array(accountSchema).default([]), audit: z.array(auditSchema),
  transactionRefs: z.array(transactionRefSchema).default([]), openingBalances: z.array(openingBalanceSchema).default([]), closings: z.array(closingSchema).default([]),
  annualClosings:z.array(annualClosingSchema).optional(),
  invitations: z.array(invitationSchema).optional(),
  standardAccounts:z.array(standardAccountSchema).optional(),
  accountImports:z.array(z.object({id:z.uuid(),departmentId:z.uuid(),actorUserId:z.uuid(),standardAccountIds:z.array(z.uuid()).min(1).max(100),accountIds:z.array(z.uuid()).min(1).max(100),createdAt:z.iso.datetime()}).strict()).optional(),
  accountTemplate:z.object({enabled:z.boolean(),version:z.number().int().positive(),updatedAt:z.iso.datetime(),updatedBy:z.uuid()}).strict().optional(),
}).strict().superRefine((s, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const unique = (values: string[]) => new Set(values).size === values.length;
  if(!unique((s.standardAccounts??[]).filter(a=>a.seedKey).map(a=>a.seedKey!)))issue('중복 표준 목록 키');
  if((s.standardAccounts??[]).some(a=>a.treatment&&a.treatment!=='NORMAL'&&a.type!=='INCOME'))issue('이월/환불 안내 과목은 수입 분류에만 둘 수 있습니다.');
  if((s.standardAccounts??[]).some(a=>a.isDefault&&a.status!=='ACTIVE'))issue('기본 과목은 활성 상태여야 합니다. 기본 지정을 먼저 해제하세요.');
  if(s.accountTemplate?.enabled&&!(s.standardAccounts??[]).some(a=>a.isDefault&&a.status==='ACTIVE'))issue('자동 등록 템플릿에는 활성 기본 과목이 필요합니다.');
  if(s.accountTemplate&&!s.users.some(u=>u.id===s.accountTemplate!.updatedBy))issue('템플릿 작성자 참조 오류');
  for(const values of [(s.standardAccounts??[]).map(a=>a.id),(s.standardAccounts??[]).map(a=>normalizeAccountText(a.code)),(s.standardAccounts??[]).map(a=>[a.type,a.majorCategory,a.minorCategory,a.name].map(normalizeAccountText).join('\u0000')),s.accounts.filter(a=>a.standardAccountId).map(a=>`${a.departmentId}:${a.standardAccountId}`),(s.accountImports??[]).map(a=>a.id)])if(!unique(values))issue('중복 공통 과목/가져오기');
  for(const a of s.standardAccounts??[])if(!s.users.some(u=>u.id===a.createdBy)||!s.users.some(u=>u.id===a.updatedBy))issue('공통 과목 작성자 참조 오류');
  for(const a of s.accounts)if(a.standardAccountId&&(!a.standardAccountVersion||!a.majorCategory||!a.minorCategory||!a.importedAt||!a.importedBy))issue('가져오기 출처 정보 누락');
  for(const r of s.accountImports??[])if(!s.departments.some(d=>d.id===r.departmentId)||!s.users.some(u=>u.id===r.actorUserId)||r.accountIds.length!==r.standardAccountIds.length||!unique(r.standardAccountIds)||!unique(r.accountIds))issue('가져오기 기록 참조 오류');
  if (!unique((s.invitations ?? []).map(i => i.id)) || !unique((s.invitations ?? []).map(i => i.email.toLowerCase()))) issue('중복 초대');
  for (const i of s.invitations ?? []) {
    if (!s.users.some(u => u.id === i.createdBy) || !s.departments.some(d => d.id === i.departmentId)) issue('초대 참조 오류');
    if (!!i.subject !== !!i.userId || (i.userId && !s.users.some(u => u.id === i.userId && u.subject === i.subject))) issue('초대 사용자 연결 오류');
  }
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
  if(!unique([...s.closings,...(s.annualClosings??[])].map(c=>c.id)))issue('중복 마감 ID');
  if(!unique((s.annualClosings??[]).map(c=>`${c.departmentId}:${c.period}`)))issue('중복 연간 마감');
  for(const c of [...s.closings,...(s.annualClosings??[])])if(!s.departments.some(d=>d.id===c.departmentId)||(c.updatedBy&&!s.users.some(u=>u.id===c.updatedBy)))issue('마감 참조 오류');
  for(const c of s.annualClosings??[])if(c.status==='CLOSED'&&Array.from({length:12},(_,i)=>`${c.period}-${String(i+1).padStart(2,'0')}`).some(period=>!s.closings.some(m=>m.departmentId===c.departmentId&&m.period===period&&m.status==='CLOSED')))issue('연간 마감은 12개월 마감 필요');
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
export const accountCreateInput = accountSchema.pick({departmentId:true,code:true,name:true,type:true,sortOrder:true,status:true}).extend({ reason, expectedRevision: revision }).strict();
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
