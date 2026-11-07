import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { themes } from '../shared/theme';
import { assignmentInput, type Control } from './schema';
import { ApiError, type Repository } from './store';
import { authenticate, callback, cookieValue, digest, issueSession, login, sessionCookie, type AuthConfig } from './auth';
import { allowedDepartments, koreaDate, requireAdmin, requireDepartment } from './policy';
import { handleMasterData } from './master-data';
import { handleLedger } from './ledger';
import { handleReports } from './reports';
import { handleClosings } from './closings';
import { handleBackups } from './backups';
import { handleReportExport } from './report-export';
import { auditSchema, dateSchema } from './schema';
const json=(data:unknown,status=200)=>Response.json({success:true,data},{status});
async function body(req:Request){if(!req.headers.get('content-type')?.startsWith('application/json'))throw new ApiError(415,'JSON_REQUIRED','JSON 요청이 필요합니다.');const text=await req.text();if(Buffer.byteLength(text)>(new URL(req.url).pathname.includes('/admin/backups/')?4*1024*1024:16384))throw new ApiError(413,'BODY_TOO_LARGE','요청 크기가 너무 큽니다.');try{return JSON.parse(text);}catch{throw new ApiError(400,'INVALID_JSON','JSON 형식이 올바르지 않습니다.');}}
export function createApi(repo:Repository,options:{origin:string;local?:boolean;auth?:AuthConfig}){
  return async(req:Request):Promise<Response>=>{
    let response:Response;
    try {
      const url=new URL(req.url),path=url.pathname.replace('/.netlify/functions/api','/api'),method=req.method;
      if(!['GET','POST','PATCH','DELETE'].includes(method))throw new ApiError(405,'METHOD_NOT_ALLOWED','지원하지 않는 메서드입니다.');
      if(method!=='GET' && req.headers.get('origin')!==options.origin)throw new ApiError(403,'ORIGIN_REJECTED','요청 출처를 확인할 수 없습니다.');
      if(path==='/api/auth/login' && (method==='POST'||method==='GET')){
        if(!options.auth)throw new ApiError(503,'AUTH_NOT_CONFIGURED','운영 인증 제공자가 아직 연결되지 않았습니다.');
        response=await login(options.auth);
      }else if(path==='/api/auth/callback' && method==='GET'){
        if(!options.auth)throw new ApiError(503,'AUTH_NOT_CONFIGURED','운영 인증 제공자가 아직 연결되지 않았습니다.');
        response=await callback(req,repo,options.auth);
      }else if(path==='/api/auth/local-identities' && method==='GET' && options.local){
        const state=await repo.control();response=json(state.users.filter(u=>u.status==='ACTIVE' && u.subject.startsWith('local:')).map(u=>({identity:u.loginId,label:u.displayName,role:u.role})));
      }else if(path==='/api/auth/local' && method==='POST' && options.local){
        const input=await body(req);const state=await repo.control();
        const user=state.users.find(u=>u.loginId===input?.identity && u.status==='ACTIVE' && u.subject.startsWith('local:'));
        if(!user)throw new ApiError(401,'INVALID_IDENTITY','로그인을 완료하지 못했습니다.');
        response=json({local:true});response.headers.set('set-cookie',await issueSession(repo,user.subject,true));
      }else if(path==='/api/auth/logout' && method==='POST'){
        const token=cookieValue(req,options.local?'local-session':'__Host-session');if(token)await repo.deleteSession(digest(token));
        response=json(null);response.headers.set('set-cookie',sessionCookie('',0,!options.local));
      }else{
        const {state,user}=await authenticate(req,repo,options.local);
        if(path.startsWith('/api/admin/'))requireAdmin(user);
        const operation=await handleClosings({path,method,url,state,user,repo,body:()=>body(req)})??await handleBackups({path,method,url,state,user,repo,body:()=>body(req)})??await handleReportExport({path,method,url,state,user,repo});
        const master = operation ? null : await handleMasterData({path,method,url,state,user,repo,local:!!options.local,body:()=>body(req)});
        const report = operation || master ? null : await handleReports({path,method,url,state,user,repo});
        const ledger = operation || master || report ? null : await handleLedger({path,method,url,state,user,repo,body:()=>body(req)});
        if(operation)response=operation;
        else if(master)response=master;
        else if(report)response=report;
        else if(ledger)response=ledger;
        else if(path==='/api/me' && method==='GET')response=json({user:{id:user.id,displayName:user.displayName,loginId:user.loginId,role:user.role,theme:user.theme??'modern-dark'},departments:allowedDepartments(state,user),revision:state.revision,local:!!options.local,writable:repo.writable});
        else if(path==='/api/me/preferences' && method==='PATCH'){
          const input=z.object({theme:z.enum(themes),expectedRevision:z.number().int().positive()}).strict().parse(await body(req));
          const next=await repo.updateControl(input.expectedRevision,current=>{
            const actor=current.users.find(u=>u.id===user.id&&u.subject===user.subject&&u.status==='ACTIVE');
            if(!actor)throw new ApiError(401,'UNAUTHENTICATED','로그인이 필요합니다.');
            actor.theme=input.theme;return current;
          });response=json({theme:input.theme,revision:next.revision});
        }
        else if(path==='/api/departments' && method==='GET')response=json(allowedDepartments(state,user));
        else if(path==='/api/department-context' && method==='GET'){
          const id=url.searchParams.get('departmentId')??'';requireDepartment(state,user,id);response=json({department:state.departments.find(d=>d.id===id),writable:repo.writable});
        }else if(path==='/api/admin/users' && method==='GET')response=json(state.users.map(({subject,...u})=>u));
        else if(path==='/api/admin/assignments' && method==='GET')response=json({assignments:state.assignments,departments:state.departments,revision:state.revision});
        else if(path==='/api/admin/assignments' && method==='POST'){
          const input=assignmentInput.parse(await body(req));
          // Phase 1 supports immediate replacement only; never invent a historical handover.
          if(input.effectiveDate!==koreaDate())throw new ApiError(422,'IMMEDIATE_ONLY','Phase 1은 오늘 적용하는 담당자 교체만 지원합니다.');
          if(new Set(input.userIds).size!==input.userIds.length)throw new ApiError(422,'DUPLICATE_USER','담당자가 중복되었습니다.');
          const next=await repo.updateControl(input.expectedRevision,(current:Control)=>{
            // Recheck actor within the update, not just against the earlier snapshot.
            const actor=current.users.find(u=>u.id===user.id && u.status==='ACTIVE');if(!actor)throw new ApiError(401,'UNAUTHENTICATED','로그인이 필요합니다.');requireAdmin(actor);
            if(!current.departments.some(d=>d.id===input.departmentId && d.status==='ACTIVE'))throw new ApiError(422,'INVALID_DEPARTMENT','활성 부서를 선택해 주세요.');
            if(input.userIds.some(id=>!current.users.some(u=>u.id===id && u.status==='ACTIVE' && u.role==='ACCOUNTANT')))throw new ApiError(422,'INVALID_ASSIGNEE','활성 담당자를 선택해 주세요.');
            const before=current.assignments.filter(a=>a.departmentId===input.departmentId);
            if(before.some(a=>a.validFrom>input.effectiveDate))throw new ApiError(409,'FUTURE_ASSIGNMENT','예정된 배정을 먼저 검토해 주세요.');
            const yesterday=new Date(input.effectiveDate+'T00:00:00Z');yesterday.setUTCDate(yesterday.getUTCDate()-1);const end=yesterday.toISOString().slice(0,10);
            const history=current.assignments.filter(a=>a.departmentId!==input.departmentId || a.validFrom<input.effectiveDate).map(a=>a.departmentId===input.departmentId && (!a.validTo || a.validTo>=input.effectiveDate)?{...a,validTo:end}:a);
            const added=input.userIds.map(userId=>({id:randomUUID(),userId,departmentId:input.departmentId,validFrom:input.effectiveDate,validTo:null,assignedBy:user.id,reason:input.reason}));
            current.assignments=[...history,...added];current.audit.push({id:randomUUID(),actorUserId:user.id,departmentId:input.departmentId,entityType:'ASSIGNMENT',entityId:input.departmentId,action:'ASSIGNMENT_REPLACED',occurredAt:new Date().toISOString(),reason:input.reason,before,after:current.assignments.filter(a=>a.departmentId===input.departmentId)});return current;
          });response=json({revision:next.revision});
        }else if(path==='/api/admin/audit-logs' && method==='GET'){
          const q=z.object({departmentId:z.uuid().optional(),actorUserId:z.uuid().optional(),action:auditSchema.shape.action.optional(),from:dateSchema.optional(),to:dateSchema.optional(),keyword:z.string().max(100).optional(),page:z.coerce.number().int().min(1).optional()}).strict().parse(Object.fromEntries(url.searchParams));
          if(q.from&&q.to&&q.from>q.to)throw new ApiError(422,'INVALID_RANGE','기간을 확인하세요.');
          const rows=state.audit.filter(log=>(!q.departmentId||log.departmentId===q.departmentId)&&(!q.actorUserId||log.actorUserId===q.actorUserId)&&(!q.action||log.action===q.action)&&(!q.from||koreaDate(new Date(log.occurredAt))>=q.from)&&(!q.to||koreaDate(new Date(log.occurredAt))<=q.to)&&(!q.keyword||[log.reason,log.action,state.users.find(u=>u.id===log.actorUserId)?.displayName].join(' ').toLowerCase().includes(q.keyword.toLowerCase())));
          response=json(q.page?{items:rows.slice().sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.id.localeCompare(a.id)).slice((q.page-1)*50,q.page*50).map(log=>({...log,actorName:state.users.find(u=>u.id===log.actorUserId)?.displayName,departmentName:state.departments.find(d=>d.id===log.departmentId)?.name})),total:rows.length,page:q.page}:rows);
        }
        else throw new ApiError(404,'NOT_FOUND','아직 제공하지 않는 API입니다.');
      }
    }catch(error){
      if(error instanceof ApiError)response=Response.json({success:false,error:{code:error.code,message:error.message}},{status:error.status});
      else if(error instanceof ZodError)response=Response.json({success:false,error:{code:'VALIDATION_ERROR',message:'입력값 또는 저장된 자료의 형식을 확인해 주세요.'}},{status:422});
      else response=Response.json({success:false,error:{code:'SERVICE_UNAVAILABLE',message:'요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'}},{status:503});
    }
    response.headers.set('cache-control','no-store');response.headers.set('x-content-type-options','nosniff');response.headers.set('referrer-policy','no-referrer');return response;
  };
}
