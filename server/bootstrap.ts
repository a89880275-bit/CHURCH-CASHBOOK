import { randomUUID } from 'node:crypto';
import type { Control } from './schema';

// One bootstrap administrator; no example departments, assignments or accounts.
// Local authentication is a loopback verification tool, not production authentication.
export function initialControl(): Control {
  return {
    schemaVersion: 1, revision: 1,
    users: [{ id: randomUUID(), subject: 'local:owner', loginId: 'owner', displayName: '초기 관리자', role: 'ADMIN', status: 'ACTIVE', createdAt: new Date().toISOString() }],
    departments: [], assignments: [], accounts: [], audit: [], transactionRefs: [], openingBalances: [], closings: [],
  };
}
