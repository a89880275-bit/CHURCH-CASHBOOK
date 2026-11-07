import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { controlSchema, userSchema, type Control } from './schema';

export const adminProvisionInput = userSchema.pick({ subject: true, loginId: true, displayName: true }).strict().refine(u => !u.subject.startsWith('local:') && !u.subject.startsWith('archive:'), '실제 OIDC 사용자 subject가 필요합니다.');
export function productionInitialControl(input: unknown): Control {
  const admin = adminProvisionInput.parse(input);
  return controlSchema.parse({ schemaVersion: 1, revision: 1, users: [{ ...admin, id: randomUUID(), role: 'ADMIN', status: 'ACTIVE', createdAt: new Date().toISOString() }], departments: [], assignments: [], accounts: [], audit: [], transactionRefs: [], openingBalances: [], closings: [], annualClosings: [] });
}
export function validateProductionInitial(value: unknown): Control {
  const state = controlSchema.parse(value);
  if (state.revision !== 1 || state.users.length !== 1 || state.users[0].role !== 'ADMIN' || state.users[0].status !== 'ACTIVE' || state.departments.length || state.assignments.length || state.accounts.length || state.audit.length || state.transactionRefs.length || state.openingBalances.length || state.closings.length || state.annualClosings?.length) throw new Error('EMPTY_PRODUCTION_BOOTSTRAP_REQUIRED');
  adminProvisionInput.parse({ subject: state.users[0].subject, loginId: state.users[0].loginId, displayName: state.users[0].displayName });
  return state;
}
