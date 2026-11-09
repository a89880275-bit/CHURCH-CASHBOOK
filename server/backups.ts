import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountSchema,annualClosingSchema,auditSchema,closingSchema,controlSchema,departmentSchema,openingBalanceSchema,transactionRefSchema,transactionSchema,userSchema,type Control,type User,type Transaction } from './schema';
import { ApiError,type Repository } from './store';
import { requireAdmin,requireDepartment } from './policy';
import { periodBalances,readDepartment,totals,safeNumber } from './ledger';
import { periodRange } from '../shared/period';

const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const payloadSchema=z.object({format:z.enum(['church-cashbook-finance-v1','church-cashbook-finance-v2']),scope:z.enum(['ALL','DEPARTMENT']),departmentId:z.uuid().nullable(),exportedAt:z.iso.datetime(),users:z.array(userSchema.pick({id:true,displayName:true,createdAt:true})),departments:z.array(departmentSchema),accounts:z.array(accountSchema),transactionRefs:z.array(transactionRefSchema),transactions:z.array(transactionSchema),openingBalances:z.array(openingBalanceSchema),closings:z.array(closingSchema),annualClosings:z.array(annualClosingSchema),audit:z.array(auditSchema)}).strict();
const envelopeSchema=z.object({checksum:z.string().regex(/^[a-f0-9]{64}$/),payload:payloadSchema}).strict();
type Payload=z.infer<typeof payloadSchema>;
export const BACKUP_MAX_BYTES=3*1024*1024;
export async function financeBackup(repo:Repository,state:Control,departmentId?:string){
  const ids=state.departments.filter(d=>!departmentId||d.id===departmentId).map(d=>d.id);
  const transactions:Transaction[]=[];
  // A restore backup may run on one SQL transaction connection; do not issue
  // parallel queries on that connection across departments.
  for(const id of ids)transactions.push(...await readDepartment(repo,state,id));
  const audit=state.audit.filter(a=>!departmentId||(a.departmentId===departmentId&&['TRANSACTION','OPENING_BALANCE','CLOSING','STORAGE'].includes(a.entityType??'')));
  const payload:Payload={format:state.accounts.some(a=>ids.includes(a.departmentId)&&a.standardAccountId)?'church-cashbook-finance-v2':'church-cashbook-finance-v1',scope:departmentId?'DEPARTMENT':'ALL',departmentId:departmentId??null,exportedAt:new Date().toISOString(),users:state.users.map(({id,displayName,createdAt})=>({id,displayName,createdAt})),departments:state.departments.filter(d=>ids.includes(d.id)),accounts:state.accounts.filter(a=>ids.includes(a.departmentId)),transactionRefs:state.transactionRefs.filter(t=>ids.includes(t.departmentId)),transactions,openingBalances:state.openingBalances.filter(b=>ids.includes(b.departmentId)),closings:state.closings.filter(c=>ids.includes(c.departmentId)),annualClosings:(state.annualClosings??[]).filter(c=>ids.includes(c.departmentId)),audit};
  if(departmentId){const used=new Set([...transactions.flatMap(t=>[t.createdBy,t.updatedBy,...(t.deletedBy?[t.deletedBy]:[])]),...audit.map(a=>a.actorUserId),...payload.openingBalances.flatMap(b=>[b.createdBy,b.updatedBy]),...[...payload.closings,...payload.annualClosings].flatMap(c=>c.updatedBy?[c.updatedBy]:[])]);payload.users=payload.users.filter(u=>used.has(u.id));}
  return {checksum:digest(payload),payload};
}
export function parseBackup(value:unknown){
  if(Buffer.byteLength(JSON.stringify(value))>BACKUP_MAX_BYTES)throw new ApiError(413,'BACKUP_TOO_LARGE','백업 파일은 현재 3MB까지 지원합니다. 부서별 백업을 사용하세요.');
  const raw=z.object({checksum:z.string(),payload:z.unknown()}).strict().parse(value);
  if(raw.checksum!==digest(raw.payload))throw new ApiError(422,'BACKUP_CHECKSUM','백업 체크섬이 일치하지 않습니다.');
  const result=envelopeSchema.parse(value),p=result.payload,ids=p.departments.map(d=>d.id);
  if(new Set(ids).size!==ids.length||(p.scope==='DEPARTMENT'&&(ids.length!==1||ids[0]!==p.departmentId))||(p.scope==='ALL'&&p.departmentId!==null))throw new ApiError(422,'BACKUP_SCOPE','백업 범위가 올바르지 않습니다.');
  if([...p.accounts,...p.transactions,...p.transactionRefs,...p.openingBalances,...p.closings,...p.annualClosings].some(r=>!ids.includes(r.departmentId))||p.audit.some(r=>r.departmentId!==null&&!ids.includes(r.departmentId)))throw new ApiError(422,'BACKUP_SCOPE','백업 범위 밖 자료가 포함돼 있습니다.');
  if(new Set(p.transactions.map(t=>t.id)).size!==p.transactions.length||p.transactions.length!==p.transactionRefs.length||new Set(p.transactionRefs.map(t=>t.id)).size!==p.transactionRefs.length)throw new ApiError(422,'BACKUP_REFERENCES','중복 또는 누락된 거래가 있습니다.');
  for(const tx of p.transactions){const ref=p.transactionRefs.find(r=>r.id===tx.id);if(!ref||ref.departmentId!==tx.departmentId||ref.version!==tx.version||ref.hash!==digest(tx)||(tx.status==='DELETED'&&(!tx.deletedBy||!tx.deletedAt||!tx.deletionReason)))throw new ApiError(422,'BACKUP_TRANSACTION','거래 참조/해시/삭제 정보를 확인하세요.');}
  return result;
}
export function restoreCandidate(current:Control,p:Payload){
  const ids=p.departments.map(d=>d.id),next=structuredClone(current);
  for(const u of p.users)if(!next.users.some(x=>x.id===u.id))next.users.push({...u,subject:`archive:${u.id}`,loginId:`archive.${u.id}`,role:'ACCOUNTANT',status:'DISABLED'});
  for(const d of p.departments)if(!next.departments.some(x=>x.id===d.id))next.departments.push({...d,status:'INACTIVE'});
  const replace=<T extends {departmentId:string}>(old:T[],restored:T[])=>[...old.filter(r=>!ids.includes(r.departmentId)),...restored];
  next.accounts=replace(next.accounts,p.accounts);next.transactionRefs=replace(next.transactionRefs,p.transactionRefs);next.openingBalances=replace(next.openingBalances,p.openingBalances);next.closings=replace(next.closings,p.closings);next.annualClosings=replace(next.annualClosings??[],p.annualClosings);
  for(const log of p.audit){const old=next.audit.find(a=>a.id===log.id);if(old&&digest(old)!==digest(log))throw new ApiError(422,'AUDIT_CONFLICT','동일 ID의 감사이력이 서로 다릅니다.');if(!old)next.audit.push(log);}
  const parsed=controlSchema.parse(next);
  for(const id of ids){const rows=p.transactions.filter(t=>t.departmentId===id);totals(rows);
    for(const tx of rows){if(!parsed.accounts.some(a=>a.id===tx.accountId&&a.departmentId===id&&a.type===tx.type)||![tx.createdBy,tx.updatedBy,...(tx.deletedBy?[tx.deletedBy]:[])].every(uid=>parsed.users.some(u=>u.id===uid)))throw new ApiError(422,'BACKUP_REFERENCES','계정/거래 작성자 참조가 잘못되었습니다.');}
    const opening=parsed.openingBalances.find(o=>o.departmentId===id);if(opening&&rows.some(t=>t.status==='ACTIVE'&&t.date<opening.date))throw new ApiError(422,'BACKUP_OPENING','기초잔액 이전 거래가 있습니다.');
    if(opening){let balance=BigInt(opening.amount);for(const t of rows.filter(t=>t.status==='ACTIVE').sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))){balance+=t.type==='INCOME'?BigInt(t.amount):-BigInt(t.amount);safeNumber(balance);}}
    for(const c of [...parsed.closings,...(parsed.annualClosings??[])].filter(c=>c.departmentId===id&&c.status==='CLOSED')){const range=periodRange(c.period.length===4?'YEARLY':'MONTHLY',Number(c.period.slice(0,4)),Number(c.period.slice(5))||1),b=periodBalances(parsed,id,rows,range.from,range.to),s=totals(rows.filter(t=>t.date>=range.from&&t.date<=range.to));if(b.carryForward===null||b.balance===null)throw new ApiError(422,'BACKUP_CLOSING','마감 기간 기초잔액이 누락됐습니다.');if(c.summary&&(c.summary.income!==s.income||c.summary.expense!==s.expense||c.summary.count!==s.count||c.summary.carryForward!==b.carryForward||c.summary.balance!==b.balance))throw new ApiError(422,'BACKUP_CLOSING','마감 집계가 거래와 다릅니다.');}
    periodBalances(parsed,id,rows,'9999-12-31','9999-12-31');
  }return parsed;
}
function readyToRestore(current:Control,p:Payload){if([...current.closings,...(current.annualClosings??[])].some(c=>p.departments.some(d=>d.id===c.departmentId)&&c.status==='CLOSED'))throw new ApiError(409,'RESTORE_CLOSED','대상 부서의 현재 마감을 먼저 사유를 남겨 해제하세요.');}
export async function handleBackups(a:{path:string;method:string;url:URL;state:Control;user:User;repo:Repository;body:()=>Promise<unknown>}):Promise<Response|null>{
  if(a.path==='/api/backups/export'&&a.method==='GET'){
    const q=z.object({departmentId:z.uuid().optional()}).strict().parse(Object.fromEntries(a.url.searchParams));if(q.departmentId)requireDepartment(a.state,a.user,q.departmentId);else requireAdmin(a.user);
    const result=await financeBackup(a.repo,a.state,q.departmentId),text=JSON.stringify(result,null,2);if(Buffer.byteLength(text)>BACKUP_MAX_BYTES)throw new ApiError(413,'BACKUP_TOO_LARGE','현재 백업 한도 3MB를 초과했습니다. 부서별 백업을 사용하세요.');
    return new Response(text,{headers:{'content-type':'application/json','content-disposition':`attachment; filename="cashbook-${q.departmentId??'all'}-${new Date().toISOString().slice(0,10)}.json"`}});
  }
  if(!['/api/admin/backups/preview','/api/admin/backups/restore'].includes(a.path)||a.method!=='POST')return null;
  requireAdmin(a.user);
  const input=z.object({backup:z.unknown(),expectedRevision:z.number().int().positive(),confirmation:z.literal('RESTORE').optional(),checksum:z.string().optional(),reason:z.string().trim().min(2).max(500).optional()}).strict().parse(await a.body()),backup=parseBackup(input.backup);
  if(a.state.revision!==input.expectedRevision)throw new ApiError(409,'VERSION_CONFLICT','자료가 변경되었습니다. 다시 미리보기하세요.');
  readyToRestore(a.state,backup.payload);restoreCandidate(a.state,backup.payload);
  const preview={checksum:backup.checksum,revision:a.state.revision,exportedAt:backup.payload.exportedAt,departments:backup.payload.departments.map(d=>({id:d.id,name:d.name,currentTransactions:a.state.transactionRefs.filter(t=>t.departmentId===d.id).length,restoredTransactions:backup.payload.transactions.filter(t=>t.departmentId===d.id).length,...totals(backup.payload.transactions.filter(t=>t.departmentId===d.id))})),policy:'백업에 포함된 부서 회계자료를 교체합니다. 현재 사용자 권한/배정은 유지하며 기존 감사이력을 삭제하지 않습니다. 누락된 작성자는 로그인 불가 보존 계정으로 추가합니다.'};
  if(a.path.endsWith('/preview'))return Response.json({success:true,data:preview});
  if(input.confirmation!=='RESTORE'||input.checksum!==backup.checksum||!input.reason)throw new ApiError(422,'RESTORE_CONFIRMATION','미리보기 후 체크섬·복원 확인·사유가 필요합니다.');
  if(!a.repo.writable||!a.repo.commitLedger||!a.repo.saveBackup||!a.repo.putTransaction)throw new ApiError(503,'WRITE_NOT_VERIFIED','복원 전 전체 백업과 원자적 게시가 검증된 저장소가 필요합니다.');
  let recoveryFile='';const next=await a.repo.commitLedger(async current=>{
    const actor=current.users.find(u=>u.id===a.user.id&&u.subject===a.user.subject&&u.status==='ACTIVE');if(!actor)throw new ApiError(401,'UNAUTHENTICATED','로그인이 필요합니다.');requireAdmin(actor);
    if(current.revision!==input.expectedRevision)throw new ApiError(409,'VERSION_CONFLICT','미리보기 후 자료가 변경되었습니다. 다시 검증하세요.');readyToRestore(current,backup.payload);
    const candidate=restoreCandidate(current,backup.payload);
    const recovery=JSON.stringify(await financeBackup(a.repo,current),null,2);if(Buffer.byteLength(recovery)>BACKUP_MAX_BYTES)throw new ApiError(413,'RECOVERY_TOO_LARGE','복원 전 전체 사본이 현재 3MB 복원 한도를 초과합니다. 별도 복구 검수가 필요합니다.');
    recoveryFile=await a.repo.saveBackup!(recovery);
    for(const tx of backup.payload.transactions)await a.repo.putTransaction!(tx);
    for(const d of backup.payload.departments)await readDepartment(a.repo,candidate,d.id);
    candidate.audit.push({id:randomUUID(),actorUserId:actor.id,departmentId:backup.payload.departmentId,entityType:'STORAGE',entityId:backup.checksum,action:'STORAGE_RESTORED',occurredAt:new Date().toISOString(),reason:input.reason!,before:{revision:current.revision,recoveryFile},after:{checksum:backup.checksum,departments:preview.departments}});return candidate;
  });return Response.json({success:true,data:{revision:next.revision,recoveryFile}});
}
