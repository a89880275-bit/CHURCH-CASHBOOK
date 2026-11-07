import { describe,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { BlobsRepository,MemoryRepository } from '../server/store';
import { callback,sessionCookie } from '../server/auth';
import { seed,ids } from '../server/seed';
import { transactionSchema } from '../server/schema';
import { createApi } from '../server/api';

describe('production boundaries without real service credentials',()=>{
 it('never exposes the local account-picker login in production API mode',async()=>{const api=createApi(new MemoryRepository(seed()),{origin:'https://app.example'});const response=await api(new Request('https://app.example/api/auth/local',{method:'POST',headers:{origin:'https://app.example','content-type':'application/json'},body:JSON.stringify({identity:'admin'})}));expect(response.status).toBe(401);expect(response.headers.has('set-cookie')).toBe(false);});
 it('rejects malformed remote session expiry rather than treating it as non-expiring',async()=>{const repo=new BlobsRepository('isolated-contract-test',{get:async()=>({subject:'local:admin',expiresAt:'invalid'})} as never);await expect(repo.session('a'.repeat(64))).rejects.toMatchObject({code:'SESSION_STORE_INVALID'});});
 it('validates remote immutable transaction hash, identity and version and never enables writes',async()=>{
  const tx=transactionSchema.parse({id:'00000000-0000-4000-8000-000000000099',departmentId:ids.edu,date:'2026-01-01',accountId:'00000000-0000-4000-8000-000000000031',type:'INCOME',description:'원격 계약 검증',amount:100,remark:'',createdBy:ids.admin,createdAt:new Date().toISOString(),updatedBy:ids.admin,updatedAt:new Date().toISOString(),status:'ACTIVE',version:1});
  const ref={id:tx.id,departmentId:tx.departmentId,version:1,hash:createHash('sha256').update(JSON.stringify(tx)).digest('hex')};
  const get=vi.fn(async()=>tx),repo=new BlobsRepository('isolated-contract-test',{get} as never);
  expect(await repo.readTransaction(ref)).toEqual(tx);expect(get).toHaveBeenCalledWith(`transactions/${ref.departmentId}/${ref.id}/1-${ref.hash}.json`,{type:'json'});expect(repo.writable).toBe(false);
  get.mockResolvedValue({...tx,amount:200});await expect(repo.readTransaction(ref)).rejects.toMatchObject({code:'TRANSACTION_INVALID'});
  await expect(repo.updateControl()).rejects.toMatchObject({code:'WRITE_NOT_VERIFIED'});
 });
 it('rejects missing or forged OIDC flow cookies without creating any session',async()=>{
  const repo=new MemoryRepository(seed()),spy=vi.spyOn(repo,'putSession'),config={origin:'https://accounting.example',issuer:'https://provider.example/',clientId:'test-client',clientSecret:'not-a-live-secret',cookieKey:'0'.repeat(64)};
  for(const cookie of ['', '__Host-oidc=forged']){const response=await callback(new Request(config.origin+'/api/auth/callback?code=invalid&state=forged',{headers:{cookie}}),repo,config);expect(response.headers.get('location')).toBe('/?error=authentication_failed');expect(response.headers.get('set-cookie')).toContain('Max-Age=0');}
  expect(spy).not.toHaveBeenCalled();
 });
 it('requires HTTPS provider/origin configuration and secure opaque session cookies',async()=>{
  const repo=new MemoryRepository(seed());await expect(callback(new Request('https://app.example/api/auth/callback'),repo,{origin:'http://app.example',issuer:'http://provider.example',clientId:'a',clientSecret:'b',cookieKey:'bad'})).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
  expect(sessionCookie('a'.repeat(64))).toContain('__Host-session=');expect(sessionCookie('a'.repeat(64))).toContain('HttpOnly; Secure; SameSite=Lax');
 });
});
