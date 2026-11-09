import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import * as oidc from 'openid-client';
import { createApi } from '../server/api';
import { MemoryRepository } from '../server/store';
import { issueSession, type AuthConfig } from '../server/auth';
import { seed, ids } from '../server/seed';

vi.mock('openid-client',async original=>{
  const actual=await original<typeof import('openid-client')>();
  return {...actual,discovery:vi.fn(async()=>new actual.Configuration({issuer:'https://tenant.auth0.com/',authorization_endpoint:'https://tenant.auth0.com/authorize',token_endpoint:'https://tenant.auth0.com/oauth/token',end_session_endpoint:'https://tenant.auth0.com/oidc/logout'},'test-login','secret'))};
});
const origin='https://cashbook.example';
const auth:AuthConfig={origin,issuer:'https://tenant.auth0.com/',clientId:'test-login',clientSecret:'secret',cookieKey:'a'.repeat(64)};
let repo:MemoryRepository,api:ReturnType<typeof createApi>,admin:string,staff:string;
const cookie=(response:Response,name:string)=>response.headers.getSetCookie().find(c=>c.startsWith(name+'='))!.split(';')[0];
function req(path:string,session='',body?:unknown,context?:string){return new Request(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie:session,...(context?{'x-session-context':context}:{}),...(body!==undefined?{origin,'content-type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function ctx(session:string){return (await(await api(req('/me',session))).json()).data.sessionContext as string;}
beforeEach(async()=>{vi.mocked(oidc.discovery).mockClear();const state=seed();state.users.forEach(u=>u.subject='auth0|'+u.loginId);repo=new MemoryRepository(state);api=createApi(repo,{origin,auth,sessionBoundary:true});admin=(await issueSession(repo,'auth0|admin')).split(';')[0];staff=(await issueSession(repo,'auth0|accountant')).split(';')[0];});
afterEach(()=>vi.restoreAllMocks());
describe('account switch and explicit logout server boundaries',()=>{
 it.each(['admin-to-staff','staff-to-admin'])('revokes old token and validates new identity: %s',async direction=>{
   const old=direction==='admin-to-staff'?admin:staff,next=direction==='admin-to-staff'?staff:admin,before=await repo.control();
   expect((await api(req('/auth/logout',old,{mode:'switch'},await ctx(old)))).status).toBe(200);
   expect((await api(req('/me',old))).status).toBe(401);
   const me=await(await api(req('/me',next))).json();
   expect(me.data.user.role).toBe(direction==='admin-to-staff'?'ACCOUNTANT':'ADMIN');
   expect(me.data.departments.map((d:any)=>d.id)).toEqual(direction==='admin-to-staff'?[ids.edu,ids.music]:[ids.edu,ids.music,ids.mission]);
   expect((await api(req('/admin/users',next))).status).toBe(direction==='admin-to-staff'?403:200);
   expect(await repo.control()).toEqual(before);
 });
 it('uses end_session_endpoint and validates state before forced authentication',async()=>{
   const response=await api(req('/auth/logout',admin,{mode:'switch'},await ctx(admin))),body=await response.json(),url=new URL(body.data.next);
   expect(url.pathname).toBe('/oidc/logout');expect(url.searchParams.get('post_logout_redirect_uri')).toBe(origin+'/api/auth/logout/callback');
   expect(response.headers.getSetCookie().some(c=>c.includes('__Host-session=;')&&c.includes('Max-Age=0'))).toBe(true);
   const flow=cookie(response,'__Host-logout');
   const callback=await api(req('/auth/logout/callback?state='+url.searchParams.get('state'),flow));
   expect(callback.headers.get('location')).toBe('/api/auth/login?mode=switch');
   const login=await api(req('/auth/login?mode=switch',cookie(callback,'__Host-switch'))),authorization=new URL(login.headers.get('location')!);
   expect(authorization.searchParams.get('prompt')).toBe('login');expect(authorization.searchParams.get('max_age')).toBe('0');
   expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');expect(authorization.searchParams.get('nonce')).toBeTruthy();
 });
 it('explicit logout ends at signed-out page without starting new login',async()=>{
   const response=await api(req('/auth/logout',admin,{mode:'logout'},await ctx(admin))),url=new URL((await response.json()).data.next);
   const callback=await api(req('/auth/logout/callback?state='+url.searchParams.get('state'),cookie(response,'__Host-logout')));
   expect(callback.headers.get('location')).toBe('/signed-out');
 });
 it('rejects forged callbacks and direct forced-login links',async()=>{
   expect((await api(req('/auth/logout/callback?state=forged'))).headers.get('location')).toBe('/signed-out?incomplete=1');
   expect((await api(req('/auth/login?mode=switch'))).status).toBe(400);
 });
 it('rejects old-tab contexts for new-account writes and logout',async()=>{
   const oldContext=await ctx(admin);
   expect((await api(req('/auth/logout',staff,{mode:'logout'},oldContext))).status).toBe(409);
   expect((await api(req('/admin/assignments',admin,{},await ctx(staff)))).status).toBe(409);
   expect((await api(req('/me',staff))).status).toBe(200);
 });
 it('requires a context on production writes, keeps read-only clients compatible',async()=>{
   expect((await api(req('/auth/logout',admin,{}))).status).toBe(409);
   expect((await api(req('/me',admin))).status).toBe(200);
 });
 it('rejects external return targets and cross-origin logout without deleting sessions',async()=>{
   expect((await api(req('/auth/logout',admin,{returnTo:'https://evil.example'},await ctx(admin)))).status).toBe(422);
   const request=req('/auth/logout',admin,{},await ctx(admin));request.headers.set('origin','https://evil.example');expect((await api(request)).status).toBe(403);
   expect((await api(req('/me',admin))).status).toBe(200);
 });
 it('does not claim success if session deletion fails',async()=>{
   vi.spyOn(repo,'deleteSession').mockRejectedValue(new Error('failed'));
   expect((await api(req('/auth/logout',admin,{},await ctx(admin)))).status).toBe(503);
   expect((await api(req('/me',admin))).status).toBe(200);
 });
 it('distinguishes app logout from provider failure',async()=>{
   vi.mocked(oidc.discovery).mockRejectedValueOnce(new Error('network'));
   const response=await api(req('/auth/logout',admin,{},await ctx(admin)));
   expect((await response.json()).data.next).toBe('/signed-out?incomplete=1');
   expect((await api(req('/me',admin))).status).toBe(401);
 });
 it('revalidates role and active status for a newly selected session',async()=>{
   await repo.updateControl(1,state=>{state.users[1].status='DISABLED';return state;});
   expect((await api(req('/me',staff))).status).toBe(401);
 });
});
