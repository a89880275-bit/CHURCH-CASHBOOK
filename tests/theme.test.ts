import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../server/api';
import { FileRepository } from '../server/file-store';
import { MemoryRepository } from '../server/store';
import { seed } from '../server/seed';
import { issueSession } from '../server/auth';
const origin='http://127.0.0.1:5173';
let root='';
afterEach(async()=>{if(root){await rm(root,{recursive:true,force:true});root='';}});
function request(cookie:string,body?:unknown,requestOrigin=origin){return new Request(origin+'/api/me'+(body?'/preferences':''),{method:body?'PATCH':'GET',headers:{cookie,...(body?{origin:requestOrigin,'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
describe('personal theme preferences',()=>{
  async function setup(){const repo=new MemoryRepository(seed()),api=createApi(repo,{origin,local:true}),cookie=(await issueSession(repo,'local:accountant',true)).split(';')[0];return {repo,api,cookie};}
  it('keeps old records compatible and defaults to Modern Dark',async()=>{const {api,cookie}=await setup();expect((await(await api(request(cookie))).json()).data.user.theme).toBe('modern-dark');});
  it('persists on disk for a fresh repository and a second login while leaving accounting and other users unchanged',async()=>{
    root=await mkdtemp(join(tmpdir(),'theme-test-'));const repo=new FileRepository(root);await repo.initialize(seed());
    const before=await repo.control(),api=createApi(repo,{origin,local:true}),cookie=(await issueSession(repo,'local:accountant',true)).split(';')[0];
    expect((await api(request(cookie,{theme:'pastel-diary',expectedRevision:before.revision}))).status).toBe(200);
    const reopened=new FileRepository(root),after=await reopened.control();
    expect({...after,revision:before.revision,users:before.users}).toEqual(before);
    expect(after.users.filter(u=>u.subject!=='local:accountant')).toEqual(before.users.filter(u=>u.subject!=='local:accountant'));
    const secondCookie=(await issueSession(reopened,'local:accountant',true)).split(';')[0];
    expect((await(await createApi(reopened,{origin,local:true})(request(secondCookie))).json()).data.user.theme).toBe('pastel-diary');
  });
  it('rejects attempts to set another user or role',async()=>{const {api,cookie}=await setup();expect((await api(request(cookie,{theme:'pastel-diary',expectedRevision:1,userId:'other',role:'ADMIN'}))).status).toBe(422);});
  it('rejects unknown themes',async()=>{const {api,cookie}=await setup();expect((await api(request(cookie,{theme:'unknown',expectedRevision:1}))).status).toBe(422);});
  it('requires authentication and same-origin writes',async()=>{const {api,cookie}=await setup();const body={theme:'classic-light',expectedRevision:1};expect((await api(request('',body))).status).toBe(401);expect((await api(request(cookie,body,'https://other.example'))).status).toBe(403);});
  it('does not overwrite concurrent accounting changes',async()=>{const {api,cookie,repo}=await setup();await repo.updateControl(1,s=>s);expect((await api(request(cookie,{theme:'pastel-diary',expectedRevision:1}))).status).toBe(409);expect((await repo.control()).users.find(u=>u.subject==='local:accountant')?.theme).toBeUndefined();});
  it('cannot write with a disabled existing session',async()=>{const {api,cookie,repo}=await setup();await repo.updateControl(1,s=>{s.users.find(u=>u.subject==='local:accountant')!.status='DISABLED';return s;});expect((await api(request(cookie,{theme:'pastel-diary',expectedRevision:2}))).status).toBe(401);});
});
