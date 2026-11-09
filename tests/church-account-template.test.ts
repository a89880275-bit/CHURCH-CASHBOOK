import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {FileRepository} from '../server/file-store';
import {createApi} from '../server/api';
import {issueSession} from '../server/auth';
import {seed,ids} from '../server/seed';
import {CHURCH_ACCOUNT_TEMPLATE} from '../shared/church-account-template';
import {controlSchema} from '../server/schema';
let root:string,repo:FileRepository,api:ReturnType<typeof createApi>,admin:string,staff:string;
const origin='http://127.0.0.1:5173';
async function call(path:string,data?:unknown,cookie=admin,method='POST'){return api(new Request(origin+'/api'+path,{method:data===undefined?'GET':method,headers:{origin,cookie,...(data===undefined?{}:{'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}));}
const revision=async()=>(await repo.control()).revision;
async function preview(){return (await(await call('/admin/account-template/preview')).json()).data;}
async function install(){const p=await preview();const r=await call('/admin/account-template/install',{expectedRevision:p.revision,checksum:p.checksum,confirmation:'INSTALL_51',reason:'제공된 표준 목록 적용 승인'});expect(r.status).toBe(200);}
async function department(code='NEW'){const r=await call('/admin/departments',{code,name:'신규 선교회',status:'ACTIVE',managementPeriod:'YEARLY',reason:'부서 생성 검수',expectedRevision:await revision()});expect(r.status).toBe(201);return (await r.json()).data.department;}
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'cashbook-51-'));repo=new FileRepository(root);await repo.initialize(seed());api=createApi(repo,{origin,local:true});admin=(await issueSession(repo,'local:admin',true)).split(';')[0];staff=(await issueSession(repo,'local:accountant',true)).split(';')[0];});
afterEach(async()=>rm(root,{recursive:true,force:true}));
describe('51 church standards and prospective default provisioning',()=>{
 it('contains exactly the supplied 19 income, 32 expenses and 11 defaults',()=>{
  expect(CHURCH_ACCOUNT_TEMPLATE).toHaveLength(51);expect(CHURCH_ACCOUNT_TEMPLATE.filter(x=>x.type==='INCOME')).toHaveLength(19);expect(CHURCH_ACCOUNT_TEMPLATE.filter(x=>x.type==='EXPENSE')).toHaveLength(32);expect(CHURCH_ACCOUNT_TEMPLATE.filter(x=>x.isDefault)).toHaveLength(11);expect(CHURCH_ACCOUNT_TEMPLATE.filter(x=>!x.isDefault)).toHaveLength(40);expect(new Set(CHURCH_ACCOUNT_TEMPLATE.map(x=>x.id)).size).toBe(51);
  expect(CHURCH_ACCOUNT_TEMPLATE.filter(x=>x.isDefault).map(x=>x.name)).toEqual(['정기회비','교회재정','헌금','바자회수익금','전년이월','예배 및 강사비','행사비','회의식대비','홍보인쇄비','경조사비','일반소모품비']);
 });
 it('preview does not initialize or change old JSON and needs explicit confirmation',async()=>{
  const before=await repo.control(),p=await preview();expect(p.addCount).toBe(51);expect(await repo.control()).toEqual(before);expect(controlSchema.parse(before)).not.toHaveProperty('accountTemplate');
  expect((await call('/admin/account-template/install',{expectedRevision:p.revision,reason:'승인 없음'})).status).toBe(422);expect(await repo.control()).toEqual(before);
  expect((await call('/admin/account-template/preview',{expectedRevision:p.revision,enabled:true,reason:'미리보기는 읽기 전용'})).status).toBe(405);expect(await repo.control()).toEqual(before);
 });
 it('restricts template preview/apply/settings to admins',async()=>{
  expect((await call('/admin/account-template/preview',undefined,staff)).status).toBe(403);expect((await call('/admin/account-template/install',{expectedRevision:1,reason:'권한 검수'},staff)).status).toBe(403);
  expect((await call('/admin/account-template',{expectedRevision:1,enabled:true,reason:'권한 검수'},staff,'PATCH')).status).toBe(403);
 });
 it('installs additively, retains existing departments/accounts/transactions and never duplicates seed records',async()=>{
  const before=await repo.control();await install();let state=await repo.control();expect(state.standardAccounts).toHaveLength(51);expect(state.accounts).toEqual(before.accounts);expect(state.departments).toEqual(before.departments);expect(state.transactionRefs).toEqual(before.transactionRefs);expect(state.assignments).toEqual(before.assignments);
  await install();state=await repo.control();expect(state.standardAccounts).toHaveLength(51);expect(state.accounts).toEqual(before.accounts);
 });
 it('provisions exactly 11 only when a NEW department is committed',async()=>{
  await install();const created=await department(),state=await repo.control(),accounts=state.accounts.filter(x=>x.departmentId===created.id);expect(accounts).toHaveLength(11);expect(new Set(accounts.map(x=>x.code)).size).toBe(11);
  expect(state.accounts.filter(x=>x.departmentId===ids.edu)).toHaveLength(0);
  const result=await call('/admin/departments',{id:created.id,code:created.code,name:'부서명 변경',status:'ACTIVE',expectedRevision:state.revision,reason:'부서 수정 검수'},admin,'PATCH');expect(result.status).toBe(200);expect((await repo.control()).accounts).toHaveLength(11);
 });
 it('keeps the other 40 selectable and defaults marked as already active',async()=>{
  await install();const created=await department(),list=await(await call('/standard-accounts?departmentId='+created.id)).json();expect(list.data.items.filter((x:any)=>x.registration==='ACTIVE')).toHaveLength(11);expect(list.data.items.filter((x:any)=>x.registration==='AVAILABLE')).toHaveLength(40);
 });
 it('allows admins to change default flags without modifying existing department copies',async()=>{
  await install();const first=await department('ONE'),before=await repo.control(),source=before.standardAccounts!.find(x=>x.name==='특별회비')!;
  const {code,type,majorCategory,minorCategory,name,status,sortOrder}=source;
  expect((await call('/admin/standard-accounts',{id:source.id,code,type,majorCategory,minorCategory,name,status,sortOrder,isDefault:true,reason:'기본 템플릿 조정',expectedRevision:before.revision},admin,'PATCH')).status).toBe(200);
  const second=await department('TWO'),after=await repo.control();expect(after.accounts.filter(x=>x.departmentId===first.id)).toEqual(before.accounts.filter(x=>x.departmentId===first.id));expect(after.accounts.filter(x=>x.departmentId===second.id)).toHaveLength(12);
 });
 it('can disable prospective auto registration without removing existing accounts',async()=>{
  await install();const created=await department('ONE'),before=await repo.control();expect((await call('/admin/account-template',{expectedRevision:before.revision,enabled:false,reason:'자동 등록 중지'},admin,'PATCH')).status).toBe(200);const second=await department('TWO'),after=await repo.control();expect(after.accounts.filter(x=>x.departmentId===created.id)).toHaveLength(11);expect(after.accounts.filter(x=>x.departmentId===second.id)).toHaveLength(0);
 });
 it('rejects carry and unreviewed refund ordinary transactions without adding income',async()=>{
  await install();const created=await department(),state=await repo.control(),carry=state.accounts.find(x=>x.departmentId===created.id&&x.treatment==='OPENING_BALANCE')!;
  const transaction=(accountId:string)=>({departmentId:created.id,accountId,date:'2026-11-01',type:'INCOME',description:'이중 집계 검수',amount:1000,remark:'',reason:'거래 검수',requestId:randomUUID()});
  expect((await call('/transactions',transaction(carry.id))).status).toBe(422);
  const refund=state.standardAccounts!.find(x=>x.name==='환불금')!;expect((await call('/accounts/import',{departmentId:created.id,standardAccountIds:[refund.id],expectedRevision:state.revision,requestId:randomUUID(),reason:'환불 과목 선택'})).status).toBe(201);
  const copy=(await repo.control()).accounts.find(x=>x.departmentId===created.id&&x.standardAccountId===refund.id)!;
  expect((await call('/transactions',transaction(copy.id))).status).toBe(422);expect((await repo.control()).transactionRefs).toHaveLength(0);
 });
 it('counts opening balance once and excludes it from income performance',async()=>{
  await install();const created=await department();let state=await repo.control();
  expect((await call('/admin/opening-balances',{departmentId:created.id,date:'2026-01-01',amount:1200,expectedRevision:state.revision,reason:'전년이월 기초잔액'})).status).toBe(200);
  state=await repo.control();const account=state.accounts.find(x=>x.departmentId===created.id&&x.name==='정기회비')!;
  expect((await call('/transactions',{departmentId:created.id,accountId:account.id,date:'2026-11-01',type:'INCOME',description:'정상 수입',amount:100,remark:'',reason:'거래 등록',requestId:randomUUID()})).status).toBe(201);
  const result=await(await call('/transactions?departmentId='+created.id+'&from=2026-01-01&to=2026-12-31')).json();expect(result.data.totals.income).toBe(100);expect(result.data.carryForward).toBe(1200);expect(result.data.balance).toBe(1300);
 });
 it('generates master codes when omitted instead of asking the user',async()=>{
  const r=await call('/admin/standard-accounts',{name:'자동 코드 과목',type:'INCOME',majorCategory:'수입',minorCategory:'일반',status:'ACTIVE',sortOrder:1,expectedRevision:1,reason:'자동 발급 검수'});expect(r.status).toBe(201);expect((await r.json()).data.account.code).toMatch(/^SI\d{6}$/);
 });
 it('does not auto-merge existing same-name masters when applying the 51 standards',async()=>{
  await call('/admin/standard-accounts',{name:'정기회비',code:'OLD',type:'INCOME',majorCategory:'기존',minorCategory:'일반',status:'ACTIVE',sortOrder:1,expectedRevision:1,reason:'기존 과목 검수'});const before=await repo.control(),p=await preview();expect(p.conflicts).toHaveLength(1);
  expect((await call('/admin/account-template/install',{expectedRevision:p.revision,checksum:p.checksum,confirmation:'INSTALL_51',reason:'충돌 검수'})).status).toBe(409);expect(await repo.control()).toEqual(before);
 });
});
