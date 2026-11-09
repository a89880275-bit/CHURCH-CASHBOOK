import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createApi} from '../server/api';
import {FileRepository} from '../server/file-store';
import {issueSession} from '../server/auth';
import {seed,ids} from '../server/seed';
import {controlSchema} from '../server/schema';
import {financeBackup,parseBackup,restoreCandidate} from '../server/backups';
const origin='http://127.0.0.1:5173';
let root:string,repo:FileRepository,api:ReturnType<typeof createApi>,admin:string,staff:string,counter:number;
const legacyId='00000000-0000-4000-8000-000000000091';
async function call(path:string,data?:unknown,cookie=admin,method='POST'){
 return api(new Request(origin+'/api'+path,{method:data===undefined?'GET':method,headers:{origin,cookie,...(data===undefined?{}:{'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}));
}
const rev=async()=>(await repo.control()).revision;
async function source(name='선교회비',type:'INCOME'|'EXPENSE'='INCOME'){
 const fields={code:'S'+(++counter),name,type,majorCategory:type==='INCOME'?'수입분류':'지출분류',minorCategory:'일반',sortOrder:10,status:'ACTIVE' as const};
 const response=await call('/admin/standard-accounts',{...fields,expectedRevision:await rev(),reason:'표준 과목 등록'});
 expect(response.status).toBe(201);return (await response.json()).data.account;
}
async function take(standardAccountIds:string[],departmentId=ids.edu,extra={}){return call('/accounts/import',{standardAccountIds,departmentId,requestId:randomUUID(),expectedRevision:await rev(),reason:'부서 과목 가져오기',...extra},staff);}
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'cashbook-catalog-'));repo=new FileRepository(root);const s=seed();
 s.accounts=[{id:legacyId,departmentId:ids.edu,code:'I000001',name:'기존 회비',type:'INCOME',sortOrder:10,status:'ACTIVE'},{id:randomUUID(),departmentId:ids.edu,code:'I000002',name:'중지 과목',type:'INCOME',sortOrder:20,status:'INACTIVE'}];
 await repo.initialize(s);api=createApi(repo,{origin,local:true});counter=0;
 admin=(await issueSession(repo,'local:admin',true)).split(';')[0];staff=(await issueSession(repo,'local:accountant',true)).split(';')[0];
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
describe('standard account catalog using actual JSON persistence',()=>{
 it('keeps old serialized control/checksum unchanged and introduces no default collections',async()=>{
  const old=await repo.control(),parsed=controlSchema.parse(JSON.parse(JSON.stringify(old)));
  const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');expect(hash(parsed)).toBe(hash(old));expect(parsed).not.toHaveProperty('standardAccounts');expect(parsed).not.toHaveProperty('accountImports');
 });
 it('allows only admins to write standards and never exposes other departments usage',async()=>{
  const item=await source();
  expect((await call('/admin/standard-accounts',{...item,reason:'시도',expectedRevision:await rev()},staff)).status).toBe(403);
  expect((await call('/standard-accounts?departmentId='+ids.mission,undefined,staff)).status).toBe(403);
  const result=await(await call('/standard-accounts',undefined,staff)).json();expect(result.data.items).toHaveLength(1);expect(result.data.items[0].similarAccounts).toEqual([]);
 });
 it('rejects normalized duplicate codes, duplicate categories/name and type changes',async()=>{
  const item=await source();
  const fields={code:'Ｓ１',name:'다른이름',type:'INCOME',majorCategory:'다른분류',minorCategory:'일반',status:'ACTIVE',sortOrder:1,expectedRevision:await rev(),reason:'중복 검수'};
  expect((await call('/admin/standard-accounts',fields)).status).toBe(409);
  expect((await call('/admin/standard-accounts',{...fields,code:'S2',name:item.name,majorCategory:item.majorCategory})).status).toBe(409);
  const {id,code,name,type,majorCategory,minorCategory,status,sortOrder}=item;
  expect((await call('/admin/standard-accounts',{id,code,name,type:'EXPENSE',majorCategory,minorCategory,status,sortOrder,reason:'유형 변경',expectedRevision:await rev()},admin,'PATCH')).status).toBe(409);
 });
 it('allocates codes within a department including inactive code reservations, independently',async()=>{
  const item=await source();expect((await take([item.id])).status).toBe(201);expect((await take([item.id],ids.music)).status).toBe(201);
  const copies=(await repo.control()).accounts.filter(a=>a.standardAccountId===item.id);expect(copies).toHaveLength(2);expect(copies[0].code).toBe('I000003');expect(copies[1].code).toBe('I000001');expect(copies[0].id).not.toBe(copies[1].id);
 });
 it('rolls back a whole selection if any source is inactive or invalid',async()=>{
  const item=await source(),before=await repo.control();
  expect((await take([item.id,randomUUID()])).status).toBe(409);expect(await repo.control()).toEqual(before);
  expect((await take([item.id,item.id])).status).toBe(422);expect(await repo.control()).toEqual(before);
 });
 it('rejects another department even when valid standard IDs are supplied',async()=>{
  const item=await source(),before=await repo.control();expect((await take([item.id],ids.mission)).status).toBe(403);expect(await repo.control()).toEqual(before);
 });
 it('makes request replay safe and concurrent reservations conflict without duplicates',async()=>{
  const item=await source(),revision=await rev(),requestId=randomUUID();
  const results=await Promise.all([take([item.id],ids.edu,{expectedRevision:revision,requestId}),take([item.id],ids.edu,{expectedRevision:revision})]);
  expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  const savedRequestId=(await repo.control()).accountImports![0].id;
  expect((await take([item.id],ids.edu,{expectedRevision:revision,requestId:savedRequestId})).status).toBe(200);
  expect((await take([item.id])).status).toBe(409);expect((await repo.control()).accounts.filter(a=>a.standardAccountId===item.id)).toHaveLength(1);
 });
 it('does not auto-link matching legacy names and supports explicit admin source linking',async()=>{
  const item=await source('기존 회비'),before=await repo.control();expect((await take([item.id])).status).toBe(409);
  const list=await(await call('/standard-accounts?departmentId='+ids.edu,undefined,staff)).json();expect(list.data.items[0].registration).toBe('REVIEW');
  const body={departmentId:ids.edu,accountId:legacyId,standardAccountId:item.id,expectedRevision:await rev(),reason:'기존 과목 원본 확인'};
  expect((await call('/admin/standard-accounts/link',body,staff)).status).toBe(403);expect((await call('/admin/standard-accounts/link',body)).status).toBe(200);
  const linked=(await repo.control()).accounts.find(x=>x.id===legacyId)!;expect(linked.code).toBe(before.accounts[0].code);expect(linked.name).toBe(before.accounts[0].name);expect(linked.standardAccountId).toBe(item.id);
 });
 it('preserves import metadata through ordinary account edit and displays inactive registration',async()=>{
  const item=await source();await take([item.id]);let state=await repo.control(),account=state.accounts.find(a=>a.standardAccountId===item.id)!;
  const {id,departmentId,code,name,type,sortOrder}=account;
  expect((await call('/accounts',{id,departmentId,code,name,type,sortOrder,status:'INACTIVE',reason:'사용 중지 검수',expectedRevision:state.revision},staff,'PATCH')).status).toBe(200);
  state=await repo.control();expect(state.accounts.find(a=>a.id===id)?.standardAccountId).toBe(item.id);
  expect((await(await call('/standard-accounts?departmentId='+ids.edu,undefined,staff)).json()).data.items[0].registration).toBe('INACTIVE');expect((await take([item.id])).status).toBe(409);
 });
 it('never propagates source rename or deactivation into existing accounts and history',async()=>{
  const item=await source();await take([item.id]);const state=await repo.control(),account=state.accounts.find(a=>a.standardAccountId===item.id)!;
  const tx=await call('/transactions',{departmentId:ids.edu,date:'2026-11-01',accountId:account.id,type:'INCOME',description:'보존 검수',amount:700,remark:'',reason:'거래 검수',requestId:randomUUID()},staff);expect(tx.status).toBe(201);
  const before=await repo.control(),fields={code:item.code,name:'변경된 원본',type:item.type,majorCategory:item.majorCategory,minorCategory:item.minorCategory,status:'INACTIVE',sortOrder:10};
  expect((await call('/admin/standard-accounts',{...fields,id:item.id,expectedRevision:before.revision,reason:'원본 사용 중지'},admin,'PATCH')).status).toBe(200);
  expect((await repo.control()).accounts).toEqual(before.accounts);expect((await repo.control()).transactionRefs).toEqual(before.transactionRefs);
  const ledger=await(await call('/transactions?departmentId='+ids.edu,undefined,staff)).json();expect(ledger.data.totals.income).toBe(700);expect(ledger.data.items[0].account.name).toBe(item.name);
 });
 it('roundtrips v2 department backups with missing source master and retains v1 support',async()=>{
  const v1=await financeBackup(repo,await repo.control(),ids.edu);expect(parseBackup(v1).payload.format).toBe('church-cashbook-finance-v1');
  const item=await source();await take([item.id]);const backup=await financeBackup(repo,await repo.control(),ids.edu);expect(parseBackup(backup).payload.format).toBe('church-cashbook-finance-v2');
  const target=seed(),restored=restoreCandidate(target,parseBackup(backup).payload);expect(restored.standardAccounts).toBeUndefined();expect(restored.accounts.find(a=>a.standardAccountId===item.id)?.name).toBe(item.name);
 });
 it('backs up, previews and restores only catalog with durable pre-restore copy',async()=>{
  const item=await source();await take([item.id]);const response=await call('/admin/standard-accounts/export'),backup=await response.json();
  const before=await repo.control();const {id,code,type,majorCategory,minorCategory,status,sortOrder}=item;
  await call('/admin/standard-accounts',{id,code,type,majorCategory,minorCategory,status,sortOrder,name:'새 원본명',expectedRevision:before.revision,reason:'원본명 수정'},admin,'PATCH');
  const revision=await rev();expect((await call('/admin/standard-accounts/preview',{backup,expectedRevision:revision})).status).toBe(200);
  const restored=await call('/admin/standard-accounts/restore',{backup,expectedRevision:revision,confirmation:'RESTORE',reason:'공통 원본 복원'});expect(restored.status).toBe(200);
  const current=await repo.control();expect(current.accounts).toEqual(before.accounts);expect(current.users).toEqual(before.users);expect(current.assignments).toEqual(before.assignments);expect(current.standardAccounts![0].name).toBe(item.name);expect(current.standardAccounts![0].version).toBeGreaterThan(item.version);
  const file=(await restored.json()).data.recoveryFile;expect(file).toBeTruthy();
 });
 it('rejects corrupted catalog backup and stale preview',async()=>{
  await source();const backup=await(await call('/admin/standard-accounts/export')).json(),valid=structuredClone(backup);backup.payload.standardAccounts[0].name='변조';
  expect((await call('/admin/standard-accounts/preview',{backup,expectedRevision:await rev()})).status).toBe(422);
  expect((await call('/admin/standard-accounts/preview',{backup:valid,expectedRevision:1})).status).toBe(409);
 });
});
