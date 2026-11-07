import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { mkdtemp,readFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { FileRepository } from '../server/file-store';
import { createApi } from '../server/api';
import { seed,ids } from '../server/seed';
import { issueSession } from '../server/auth';
import { financeBackup,parseBackup,restoreCandidate } from '../server/backups';
import { unzip } from './xlsx-utils';

const origin='http://127.0.0.1:5173',account='00000000-0000-4000-8000-000000000031';
let root:string,repo:FileRepository,api:ReturnType<typeof createApi>,admin:string,staff:string;
function req(path:string,cookie=admin,body?:unknown,method='POST'){return new Request(origin+'/api'+path,{method:body===undefined?'GET':method,headers:{cookie,origin,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function tx(amount=100,extra={}){const r=await api(req('/transactions',staff,{departmentId:ids.edu,requestId:randomUUID(),date:'2026-05-10',type:'INCOME',accountId:account,description:'운영 검증',amount,remark:'',...extra}));expect(r.status).toBe(201);return (await r.json()).data.transaction;}
async function close(kind:'MONTH'|'YEAR',period:string,operation:'CLOSE'|'REOPEN'='CLOSE',cookie=admin,revision?:number){return api(req('/admin/closings',cookie,{departmentId:ids.edu,kind,period,operation,reason:'마감 검증 사유',expectedRevision:revision??(await repo.control()).revision}));}
async function backup(departmentId?:string,cookie=admin){const r=await api(req('/backups/export'+(departmentId?'?departmentId='+departmentId:''),cookie));expect(r.status).toBe(200);return r.json();}
async function preview(archive:unknown,cookie=admin){return api(req('/admin/backups/preview',cookie,{backup:archive,expectedRevision:(await repo.control()).revision}));}
async function restore(archive:any,revision?:number,cookie=admin){return api(req('/admin/backups/restore',cookie,{backup:archive,expectedRevision:revision??(await repo.control()).revision,checksum:archive.checksum,confirmation:'RESTORE',reason:'검증한 회계자료 복원'}));}
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'cashbook-ops-'));repo=new FileRepository(root);const s=seed();s.accounts=[{id:account,departmentId:ids.edu,code:'I001',name:'회비',type:'INCOME',status:'ACTIVE',sortOrder:1}];s.openingBalances=[{id:randomUUID(),departmentId:ids.edu,date:'2026-01-01',amount:1000,createdBy:ids.admin,createdAt:new Date().toISOString(),updatedBy:ids.admin,updatedAt:new Date().toISOString()}];await repo.initialize(s);api=createApi(repo,{origin,local:true});admin=(await issueSession(repo,'local:admin',true)).split(';')[0];staff=(await issueSession(repo,'local:accountant',true)).split(';')[0];
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
describe('monthly/yearly close workflows',()=>{
 it('closes with a verified snapshot, blocks even administrator transaction edits, reopens with audit',async()=>{
  const t=await tx();expect((await close('MONTH','2026-05')).status).toBe(200);
  const s=await repo.control();expect(s.closings[0].summary).toMatchObject({income:100,expense:0,balance:1100,carryForward:1000,count:1});
  expect((await api(req('/transactions',admin,{...t,requestId:randomUUID()}))).status).not.toBe(201);
  expect((await api(req('/transactions',admin,{id:t.id,departmentId:ids.edu,expectedVersion:1,reason:'수정 차단 확인'},'DELETE'))).status).toBe(409);
  expect((await close('MONTH','2026-05','REOPEN')).status).toBe(200);expect((await repo.control()).audit.map(a=>a.action)).toEqual(expect.arrayContaining(['MONTH_CLOSED','MONTH_REOPENED']));
 });
 it('requires twelve closed months and annual reopening before any monthly reopening',async()=>{
  expect((await close('YEAR','2026')).status).toBe(409);
  for(let m=1;m<=12;m++)expect((await close('MONTH',`2026-${String(m).padStart(2,'0')}`)).status).toBe(200);
  expect((await close('YEAR','2026')).status).toBe(200);expect((await(await api(req('/reports/annual?year=2026&departmentId='+ids.edu))).json()).data.annualStatus).toBe('CLOSED');expect((await close('MONTH','2026-05','REOPEN')).status).toBe(409);
  expect((await close('YEAR','2026','REOPEN')).status).toBe(200);expect((await repo.control()).closings.every(c=>c.status==='CLOSED')).toBe(true);expect((await close('MONTH','2026-05','REOPEN')).status).toBe(200);
 });
 it('denies staff mutations, anonymous requests, stale revisions, missing opening balance and malformed periods',async()=>{
  expect((await close('MONTH','2026-05','CLOSE',staff)).status).toBe(403);expect((await close('MONTH','2026-05','CLOSE','')).status).toBe(401);expect((await close('MONTH','2026-05','CLOSE',admin,999)).status).toBe(409);expect((await close('YEAR','2026-05')).status).toBe(422);
  await repo.commitLedger(s=>{s.openingBalances=[];return s;});expect((await close('MONTH','2026-05')).status).toBe(422);
 });
 it('serializes two competing close requests without duplicate closures',async()=>{const revision=(await repo.control()).revision;const results=await Promise.all([close('MONTH','2026-05','CLOSE',admin,revision),close('MONTH','2026-05','CLOSE',admin,revision)]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect((await repo.control()).closings).toHaveLength(1);});
 it('restricts closing reads to the current assigned department',async()=>{expect((await api(req('/closings?departmentId='+ids.mission+'&year=2026',staff))).status).toBe(403);expect((await api(req('/closings?departmentId='+ids.edu+'&year=2026',staff))).status).toBe(200);});
});
describe('financial JSON backup and restore',()=>{
 it('includes all immutable current objects and omits login secrets/roles from archive users',async()=>{await tx();const archive=await backup();expect(parseBackup(archive).payload.transactions).toHaveLength(1);expect(archive.payload.users[0]).not.toHaveProperty('subject');expect(archive.payload.users[0]).not.toHaveProperty('role');});
 it('permits staff only assigned-department exports, denies whole and other-department exports/restores',async()=>{expect((await api(req('/backups/export',staff))).status).toBe(403);expect((await api(req('/backups/export?departmentId='+ids.mission,staff))).status).toBe(403);await backup(ids.edu,staff);const archive=await backup();expect((await preview(archive,staff)).status).toBe(403);expect((await restore(archive,undefined,staff)).status).toBe(403);});
 it('roundtrips accounting data while preserving current authorizations and audit and creates a full recovery file',async()=>{
  await tx();const archive=await backup(ids.edu);await tx(200);const before=await repo.control(),p=await preview(archive);expect(p.status).toBe(200);const view=(await p.json()).data;expect(view.departments[0]).toMatchObject({currentTransactions:2,restoredTransactions:1,income:100});expect((await repo.control()).revision).toBe(before.revision);
  const r=await restore(archive,view.revision);expect(r.status).toBe(200);const after=await repo.control();expect(after.transactionRefs).toHaveLength(1);expect(after.users).toEqual(before.users);expect(after.assignments).toEqual(before.assignments);expect(after.audit).toHaveLength(before.audit.length+1);expect(after.audit.at(-1)?.action).toBe('STORAGE_RESTORED');
  const files=await readdir(join(root,'backups'));expect(files).toHaveLength(1);const recovery=JSON.parse(await readFile(join(root,'backups',files[0]),'utf8'));expect(parseBackup(recovery).payload.transactions).toHaveLength(2);
 });
 it('keeps unrelated department accounting intact on department restore',async()=>{await tx();const archive=await backup(ids.edu);await tx(200);const before=await repo.control();expect((await restore(archive)).status).toBe(200);const after=await repo.control();expect(after.departments.filter(d=>d.id!==ids.edu)).toEqual(before.departments.filter(d=>d.id!==ids.edu));});
 it('rejects malformed checksums, missing objects, invalid references and changed files before publishing',async()=>{
  await tx();const archive=await backup(ids.edu),before=await repo.control();archive.payload.transactions[0].amount=999;expect((await preview(archive)).status).toBe(422);expect(await repo.control()).toEqual(before);
  const broken=await backup(ids.edu);broken.payload.transactions=[];broken.checksum=createHash('sha256').update(JSON.stringify(broken.payload)).digest('hex');expect((await preview(broken)).status).toBe(422);expect(await repo.control()).toEqual(before);
 });
 it('requires current closures to be reopened and rejects edits after preview',async()=>{await tx();const archive=await backup(ids.edu);await close('MONTH','2026-05');expect((await preview(archive)).status).toBe(409);await close('MONTH','2026-05','REOPEN');const revision=(await repo.control()).revision;await tx(50);expect((await restore(archive,revision)).status).toBe(409);});
 it('preserves current.json when pre-restore backup storage fails',async()=>{
  await tx();const archive=await backup(ids.edu);await tx(200);const before=await repo.control(),brokenRepo=new FileRepository(root);brokenRepo.saveBackup=async()=>{throw new Error('disk full');};const brokenApi=createApi(brokenRepo,{origin,local:true});const r=await brokenApi(req('/admin/backups/restore',admin,{backup:archive,expectedRevision:before.revision,checksum:archive.checksum,confirmation:'RESTORE',reason:'실패 검증'}));expect(r.status).toBe(503);expect(await repo.control()).toEqual(before);
 });
 it('rejects restore publication failure without losing old references',async()=>{
  await tx();const archive=await backup(ids.edu);await tx(200);const before=await repo.control(),brokenRepo=new FileRepository(root,{replaceFile:async()=>{throw new Error('publish failure');}});const brokenApi=createApi(brokenRepo,{origin,local:true});const r=await brokenApi(req('/admin/backups/restore',admin,{backup:archive,expectedRevision:before.revision,checksum:archive.checksum,confirmation:'RESTORE',reason:'게시 실패 확인'}));expect(r.status).toBe(503);expect(await repo.control()).toEqual(before);expect(await readdir(join(root,'backups'))).toHaveLength(1);
 });
 it('restores a closed backup only if its recorded totals match its transactions',async()=>{await tx();await close('MONTH','2026-05');const archive=await backup(ids.edu);await close('MONTH','2026-05','REOPEN');expect((await preview(archive)).status).toBe(200);archive.payload.closings[0].summary.income=5;archive.checksum=createHash('sha256').update(JSON.stringify(archive.payload)).digest('hex');expect((await preview(archive)).status).toBe(422);});
});
describe('report Excel and audit filtering',()=>{
 it.each(['monthly','account-monthly','annual','departments'])('exports the %s report as a real workbook',async route=>{await tx();const response=await api(req(`/reports/${route}.xlsx?year=2026&departmentId=${ids.edu}${route==='account-monthly'?'&type=INCOME':''}`));expect(response.status).toBe(200);expect(Object.keys(unzip(Buffer.from(await response.arrayBuffer())))).toHaveLength(6);});
 it('denies global or other-department report exports to accountants',async()=>{expect((await api(req('/reports/annual.xlsx?year=2026',staff))).status).toBe(403);expect((await api(req('/reports/monthly.xlsx?year=2026&departmentId='+ids.mission,staff))).status).toBe(403);});
 it('filters audit by current actor, department, action, dates and keyword without changing original records',async()=>{await tx();await close('MONTH','2026-05');await repo.commitLedger(s=>{s.audit.at(-1)!.occurredAt='2000-01-01T00:00:00Z';return s;});const before=await repo.control();const r=await api(req('/admin/audit-logs?'+new URLSearchParams({page:'1',departmentId:ids.edu,actorUserId:ids.admin,action:'MONTH_CLOSED',keyword:'검증',from:'2000-01-01',to:'9999-12-31'})));expect(r.status).toBe(200);const data=(await r.json()).data;expect(data.total).toBe(1);expect(data.items[0].action).toBe('MONTH_CLOSED');expect((await(await api(req('/admin/audit-logs?page=1'))).json()).data.items[0].action).toBe('TRANSACTION_CREATED');expect(await repo.control()).toEqual(before);expect((await api(req('/admin/audit-logs?page=1',staff))).status).toBe(403);});
});
