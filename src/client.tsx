import { createContext } from 'react';
import type { Theme } from '../shared/theme';
import { scopedRequest } from './session-boundary';
export type Department = { id: string; name: string; code: string; status: 'ACTIVE' | 'INACTIVE'; createdAt?: string; managementPeriod?: 'MONTHLY' | 'YEARLY' };
export type User = { id: string; displayName: string; role: 'ADMIN' | 'ACCOUNTANT'; loginId: string; status?: 'ACTIVE' | 'DISABLED'; theme?: Theme };
export type Me = { sessionContext?:string; user: User; departments: Department[]; revision: number; local: boolean; writable: boolean };
export class ApiFailure extends Error { constructor(message: string, public status: number, public code: string) { super(message); } }
export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  return scopedRequest('/api' + path, {
    ...(body !== undefined ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  },async (response,assertCurrent)=>{
  let result;
  try { result = await response.json(); } catch { throw new ApiFailure('API 응답을 확인할 수 없습니다. 서버 연결을 확인해 주세요.', response.status, 'INVALID_RESPONSE'); }
  assertCurrent();
  if (!response.ok) {
    if(response.status===409&&result.error?.code==='SESSION_CONTEXT_CHANGED')window.dispatchEvent(new Event('session-expired'));
    if (response.status === 401 && path !== '/me' && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-expired'));
    throw new ApiFailure(result.error?.message ?? '요청을 완료하지 못했습니다.', response.status, result.error?.code ?? 'REQUEST_FAILED');
  }
  return result.data;
  });
}
export const Session = createContext<{ me: Me; refresh: () => Promise<void>; department: string; setDepartment: (id: string) => void }>({} as never);
