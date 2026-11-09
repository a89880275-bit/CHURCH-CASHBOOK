import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import { standardAccountFields,standardAccountSchema,normalizeAccountText as norm } from '../shared/account-catalog';
import { controlSchema,type Control,type User } from './schema';
import { requireAdmin,requireDepartment } from './policy';
import { provisionAccounts } from './account-provisioning';
import { ApiError,type Repository } from './store';
const json=(data:unknown,status=200)=>Response.json({success:true,data},{status});
const revision=z.number().int().positive(),reason=z.string().trim().min(2).max(500);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const createInput=standardAccountFields.omit({seedKey:true,code:true}).extend({code:z.string().trim().min(1).max(30).optional(),expectedRevision:revision,reason}).strict();
const updateInput=createInput.extend({id:z.uuid()}).strict();
const importInput=z.object({departmentId:z.uuid(),standardAccountIds:z.array(z.uuid()).min(1).max(100),expectedRevision:revision,requestId:z.uuid(),reason}).strict();
const linkInput=z.object({departmentId:z.uuid(),accountId:z.uuid(),standardAccountId:z.uuid(),expectedRevision:revision,reason}).strict();
const archivePayload=z.object({format:z.enum(['church-cashbook-catalog-v1','church-cashbook-catalog-v2']),exportedAt:z.iso.datetime(),standardAccounts:z.array(standardAccountSchema).max(5000)}).strict();
const archive=z.object({checksum:z.string().regex(/^[a-f0-9]{64}$/),payload:archivePayload}).strict();
function actor(state:Control,user:User){const current=state.users.find(u=>u.id===user.id&&u.subject===user.subject&&u.status==='ACTIVE');if(!current)throw new ApiError(401,'UNAUTHENTICATED','로그인이 필요합니다.');return current;}
function department(state:Control,user:User,id:string){requireDepartment(state,user,id);if(!state.departments.some(d=>d.id===id&&d.status==='ACTIVE'))throw new ApiError(409,'DEPARTMENT_INACTIVE','사용 중지된 부서입니다.');}
function audit(state:Control,user:User,action:Control['audit'][number]['action'],id:string,departmentId:string|null,before:unknown,after:unknown,reason:string){state.audit.push({id:randomUUID(),actorUserId:user.id,entityType:departmentId?'ACCOUNT':'STANDARD_ACCOUNT',entityId:id,departmentId,action,occurredAt:new Date().toISOString(),reason,before,after});}
function unique(values:string[]){return new Set(values).size===values.length;}
export async function handleAccountCatalog(a:{path:string;method:string;url:URL;state:Control;user:User;repo:Repository;body:()=>Promise<unknown>}):Promise<Response|null>{
 const {path,method,state,user,repo,url}=a;
 if(path==='/api/standard-accounts'&&method==='GET'){
  const q=z.object({departmentId:z.uuid().optional(),keyword:z.string().max(100).optional(),type:z.enum(['INCOME','EXPENSE']).optional()}).strict().parse(Object.fromEntries(url.searchParams));
  if(q.departmentId)requireDepartment(state,user,q.departmentId);
  const accounts=q.departmentId?state.accounts.filter(x=>x.departmentId===q.departmentId):[];
  const items=(state.standardAccounts??[]).filter(x=>(!q.type||x.type===q.type)&&(!q.keyword||norm([x.code,x.majorCategory,x.minorCategory,x.name].join(' ')).includes(norm(q.keyword)))).map(x=>{
   const local=accounts.find(y=>y.standardAccountId===x.id),similar=accounts.filter(y=>!y.standardAccountId&&y.type===x.type&&norm(y.name)===norm(x.name));
   return {...x,registration:local?(local.status==='ACTIVE'?'ACTIVE':'INACTIVE'):similar.length?'REVIEW':'AVAILABLE',localAccountId:local?.id,similarAccounts:similar.map(y=>({id:y.id,code:y.code,name:y.name}))};
  }).sort((x,y)=>x.sortOrder-y.sortOrder||x.code.localeCompare(y.code));
  return json({items,revision:state.revision,imports:(state.accountImports??[]).filter(r=>r.departmentId===q.departmentId&&r.actorUserId===user.id)});
 }
 if(path==='/api/admin/standard-accounts'&&['POST','PATCH'].includes(method)){
  requireAdmin(user);const input=(method==='POST'?createInput:updateInput).parse(await a.body()),id='id'in input?input.id as string:randomUUID();
  const next=await repo.updateControl(input.expectedRevision,current=>{
   const admin=actor(current,user);requireAdmin(admin);
   const index=(current.standardAccounts??[]).findIndex(x=>x.id===id),before=current.standardAccounts?.[index];
   if(method==='PATCH'&&!before)throw new ApiError(404,'STANDARD_ACCOUNT_NOT_FOUND','공통 과목을 찾을 수 없습니다.');
   if(before&&before.type!==input.type)throw new ApiError(409,'ACCOUNT_TYPE_IMMUTABLE','공통 과목의 수입·지출 유형은 변경할 수 없습니다.');
   let automaticCode=before?.code;
   if(!input.code&&!automaticCode){let n=1;const used=new Set((current.standardAccounts??[]).map(x=>norm(x.code)));do{if(n>999999)throw new ApiError(409,'ACCOUNT_CODE_EXHAUSTED','표준 코드 발급 범위를 초과했습니다.');automaticCode=(input.type==='INCOME'?'SI':'SE')+String(n++).padStart(6,'0');}while(used.has(automaticCode));}
   const fields={code:input.code?norm(input.code):automaticCode!,type:input.type,majorCategory:input.majorCategory,minorCategory:input.minorCategory,name:input.name,status:input.status,sortOrder:input.sortOrder,...(before?.seedKey?{seedKey:before.seedKey}:{}),...(input.isDefault!==undefined?{isDefault:input.isDefault}:before?.isDefault!==undefined?{isDefault:before.isDefault}:{}),...(input.treatment!==undefined?{treatment:input.treatment}:before?.treatment?{treatment:before.treatment}:{})};
   if(before&&(before.treatment??'NORMAL')!==(fields.treatment??'NORMAL'))throw new ApiError(409,'ACCOUNT_TREATMENT_IMMUTABLE','처리 방식은 변경할 수 없습니다. 새 원본을 등록하세요.');
   if((current.standardAccounts??[]).some(x=>x.id!==id&&(norm(x.code)===fields.code||[x.type,x.majorCategory,x.minorCategory,x.name].map(norm).join('\0')===[fields.type,fields.majorCategory,fields.minorCategory,fields.name].map(norm).join('\0'))))throw new ApiError(409,'STANDARD_ACCOUNT_DUPLICATE','같은 표준 코드 또는 분류·이름이 이미 있습니다.');
   const time=new Date().toISOString(),after={...fields,id,version:(before?.version??0)+1,createdAt:before?.createdAt??time,createdBy:before?.createdBy??admin.id,updatedAt:time,updatedBy:admin.id};
   if(index<0)(current.standardAccounts??=[]).push(after);else current.standardAccounts![index]=after;
   audit(current,admin,before?'STANDARD_ACCOUNT_UPDATED':'STANDARD_ACCOUNT_CREATED',id,null,before??null,after,input.reason);return current;
  });return json({account:next.standardAccounts!.find(x=>x.id===id),revision:next.revision},method==='POST'?201:200);
 }
 if(path==='/api/accounts/import'&&method==='POST'){
  const input=importInput.parse(await a.body());department(state,user,input.departmentId);
  if(!unique(input.standardAccountIds))throw new ApiError(422,'DUPLICATE_SELECTION','같은 항목을 중복 선택할 수 없습니다.');
  const ids=[...input.standardAccountIds].sort(),old=state.accountImports?.find(r=>r.id===input.requestId);
  if(old){if(old.actorUserId!==user.id||old.departmentId!==input.departmentId||JSON.stringify(old.standardAccountIds)!==JSON.stringify(ids))throw new ApiError(409,'REQUEST_ID_REUSED','다른 가져오기에 사용된 요청 ID입니다.');if(old.accountIds.some((id,i)=>!state.accounts.some(x=>x.id===id&&x.departmentId===old.departmentId&&x.standardAccountId===old.standardAccountIds[i])))throw new ApiError(409,'IMPORT_RESULT_CHANGED','복원 등으로 과거 결과가 변경되었습니다. 다시 조회하세요.');return json({accountIds:old.accountIds,revision:state.revision,replayed:true});}
  const next=await repo.updateControl(input.expectedRevision,current=>{
   const writer=actor(current,user);department(current,writer,input.departmentId);
   if(current.accountImports?.some(r=>r.id===input.requestId))throw new ApiError(409,'REQUEST_ID_REUSED','처리 결과를 새로 조회하세요.');
   const selected=ids.map(id=>{const item=current.standardAccounts?.find(x=>x.id===id&&x.status==='ACTIVE');if(!item)throw new ApiError(409,'STANDARD_ACCOUNT_UNAVAILABLE','선택한 원본이 변경 또는 중지되었습니다. 다시 조회하세요.');return item;});
   const locals=current.accounts.filter(x=>x.departmentId===input.departmentId);
   for(const item of selected){if(locals.some(x=>x.standardAccountId===item.id))throw new ApiError(409,'ACCOUNT_ALREADY_IMPORTED','이미 등록된 과목입니다. 중지 계정은 재활성화하세요.');if(locals.some(x=>!x.standardAccountId&&x.type===item.type&&norm(x.name)===norm(item.name)))throw new ApiError(409,'LEGACY_ACCOUNT_REVIEW','같은 이름의 기존 과목이 있습니다. 관리자 원본 연결 확인이 필요합니다.');}
   const accountIds=provisionAccounts(current,writer,input.departmentId,selected,input.reason).map(x=>x.id);
   (current.accountImports??=[]).push({id:input.requestId,departmentId:input.departmentId,actorUserId:writer.id,standardAccountIds:ids,accountIds,createdAt:new Date().toISOString()});return current;
  });return json({accountIds:next.accountImports!.find(r=>r.id===input.requestId)!.accountIds,revision:next.revision},201);
 }
 if(path==='/api/admin/standard-accounts/link'&&method==='POST'){
  requireAdmin(user);const input=linkInput.parse(await a.body());
  const next=await repo.updateControl(input.expectedRevision,current=>{
   const admin=actor(current,user);requireAdmin(admin);department(current,admin,input.departmentId);
   const account=current.accounts.find(x=>x.id===input.accountId&&x.departmentId===input.departmentId),source=current.standardAccounts?.find(x=>x.id===input.standardAccountId&&x.status==='ACTIVE');
   if(source?.treatment&&source.treatment!=='NORMAL')throw new ApiError(409,'SPECIAL_SOURCE_MIGRATION_REQUIRED','이월/환불 원본은 기존 거래 집계 검토와 별도 이전 승인이 필요합니다. 자동 연결하지 않습니다.');
   if(!account||!source||account.type!==source.type)throw new ApiError(422,'SOURCE_LINK_INVALID','기존 계정·원본의 부서/유형/상태를 확인하세요.');
   if(account.standardAccountId||current.accounts.some(x=>x.departmentId===input.departmentId&&x.standardAccountId===source.id))throw new ApiError(409,'ACCOUNT_ALREADY_IMPORTED','이미 원본에 연결된 계정입니다.');
   const before={...account};Object.assign(account,{standardAccountId:source.id,standardAccountVersion:source.version,majorCategory:source.majorCategory,minorCategory:source.minorCategory,importedAt:new Date().toISOString(),importedBy:admin.id});audit(current,admin,'ACCOUNT_SOURCE_LINKED',account.id,input.departmentId,before,account,input.reason);return current;
  });return json({revision:next.revision});
 }
 if(path==='/api/admin/standard-accounts/export'&&method==='GET'){
  requireAdmin(user);const payload={format:(state.standardAccounts??[]).some(x=>x.seedKey||x.isDefault!==undefined||x.treatment)?'church-cashbook-catalog-v2' as const:'church-cashbook-catalog-v1' as const,exportedAt:new Date().toISOString(),standardAccounts:state.standardAccounts??[]};return new Response(JSON.stringify({checksum:digest(payload),payload},null,2),{headers:{'content-type':'application/json','content-disposition':'attachment; filename="standard-accounts.json"'}});
 }
 if(['/api/admin/standard-accounts/preview','/api/admin/standard-accounts/restore'].includes(path)&&method==='POST'){
  requireAdmin(user);const input=z.object({backup:archive,expectedRevision:revision,confirmation:z.literal('RESTORE').optional(),reason:reason.optional()}).strict().parse(await a.body());
  if(digest(input.backup.payload)!==input.backup.checksum)throw new ApiError(422,'BACKUP_CHECKSUM','공통 과목 백업 체크섬이 일치하지 않습니다.');
  const candidate=(current:Control)=>{const next=structuredClone(current),incoming=input.backup.payload.standardAccounts,ids=new Set(incoming.map(x=>x.id));next.standardAccounts=[...(current.standardAccounts??[]).filter(x=>!ids.has(x.id)).map(x=>({...x,status:'INACTIVE' as const,...(x.isDefault?{isDefault:false}:{}),version:x.version+1,updatedBy:user.id,updatedAt:new Date().toISOString()})),...incoming.map(x=>({...x,version:Math.max(x.version,current.standardAccounts?.find(a=>a.id===x.id)?.version??0)+1,updatedBy:user.id,updatedAt:new Date().toISOString()}))];return controlSchema.parse(next);};
  if(state.revision!==input.expectedRevision)throw new ApiError(409,'VERSION_CONFLICT','자료가 변경되었습니다. 다시 검증하세요.');candidate(state);
  if(path.endsWith('/preview'))return json({checksum:input.backup.checksum,revision:state.revision,count:input.backup.payload.standardAccounts.length,policy:'공통 원본만 복원합니다. 부서 계정·거래·권한은 유지하고 백업에 없는 원본은 중지합니다. 작성자가 없는 다른 환경의 원본은 별도 검토가 필요합니다.'});
  if(!input.confirmation||!input.reason)throw new ApiError(422,'RESTORE_CONFIRMATION','검증 후 복원 확인과 사유를 입력하세요.');
  if(!repo.writable||!repo.commitLedger||!repo.saveBackup)throw new ApiError(503,'WRITE_NOT_VERIFIED','복원 전 사본 보관이 가능한 저장소가 필요합니다.');
  let recoveryFile='';const next=await repo.commitLedger(async current=>{const admin=actor(current,user);requireAdmin(admin);if(current.revision!==input.expectedRevision)throw new ApiError(409,'VERSION_CONFLICT','검증 후 자료가 변경되었습니다.');const restored=candidate(current);recoveryFile=await repo.saveBackup!(JSON.stringify(current));audit(restored,admin,'STANDARD_CATALOG_RESTORED',input.backup.checksum,null,{revision:current.revision,recoveryFile},{count:input.backup.payload.standardAccounts.length},input.reason!);return restored;});return json({revision:next.revision,recoveryFile});
 }
 return null;
}
