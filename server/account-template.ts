import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CHURCH_ACCOUNT_TEMPLATE} from '../shared/church-account-template';
import {normalizeAccountText as norm} from '../shared/account-catalog';
import type {Control,User} from './schema';
import {requireAdmin} from './policy';
import {ApiError,type Repository} from './store';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function plan(state:Control){
 const current=state.standardAccounts??[],missing=CHURCH_ACCOUNT_TEMPLATE.filter(x=>!current.some(y=>y.seedKey===x.seedKey));
 const conflicts=missing.filter(x=>current.some(y=>y.id===x.id||norm(y.code)===norm(x.code)||(y.type===x.type&&norm(y.name)===norm(x.name)))).map(x=>({name:x.name,type:x.type}));
 const data={revision:state.revision,total:51,income:19,expense:32,defaults:11,optional:40,addCount:missing.length,conflicts,items:CHURCH_ACCOUNT_TEMPLATE,policy:'공통 마스터만 추가하고 신규 부서용 기본 템플릿을 활성화합니다. 기존 부서 계정·거래·기초잔액은 변경하지 않습니다. 소분류 미지정 항목은 일반으로 시작합니다.'};
 return {...data,checksum:hash(data)};
}
export async function handleAccountTemplate(a:{path:string;method:string;state:Control;user:User;repo:Repository;body:()=>Promise<unknown>}):Promise<Response|null>{
 if(!['/api/admin/account-template','/api/admin/account-template/preview','/api/admin/account-template/install'].includes(a.path))return null;
 requireAdmin(a.user);
 const json=(data:unknown)=>Response.json({success:true,data});
 if(a.method==='GET'&&a.path.endsWith('/preview'))return json(plan(a.state));
 if(a.method==='GET'&&a.path==='/api/admin/account-template')return json({revision:a.state.revision,enabled:a.state.accountTemplate?.enabled??false,defaultCount:(a.state.standardAccounts??[]).filter(x=>x.isDefault&&x.status==='ACTIVE').length,installedCount:(a.state.standardAccounts??[]).filter(x=>x.seedKey?.startsWith('junae-51-v1-')).length});
 if(!((a.path.endsWith('/install')&&a.method==='POST')||(a.path==='/api/admin/account-template'&&a.method==='PATCH')))throw new ApiError(405,'METHOD_NOT_ALLOWED','지원하지 않는 메서드입니다.');
 const input=z.object({expectedRevision:z.number().int().positive(),reason:z.string().trim().min(2).max(500),confirmation:z.literal('INSTALL_51').optional(),checksum:z.string().optional(),enabled:z.boolean().optional()}).strict().parse(await a.body());
 const next=await a.repo.updateControl(input.expectedRevision,current=>{
  const admin=current.users.find(u=>u.id===a.user.id&&u.subject===a.user.subject&&u.status==='ACTIVE');if(!admin)throw new ApiError(401,'UNAUTHENTICATED','로그인이 필요합니다.');requireAdmin(admin);
  const time=new Date().toISOString(),install=a.path.endsWith('/install');
  if(install){const preview=plan(current);if(input.confirmation!=='INSTALL_51'||input.checksum!==preview.checksum)throw new ApiError(422,'TEMPLATE_CONFIRMATION','변경 계획을 미리 확인하고 명시적으로 승인하세요.');if(preview.conflicts.length)throw new ApiError(409,'TEMPLATE_CONFLICT','기존 공통 과목과 충돌합니다. 자동 연결하지 않습니다. 관리자 검토가 필요합니다.');
   for(const item of CHURCH_ACCOUNT_TEMPLATE)if(!current.standardAccounts?.some(x=>x.seedKey===item.seedKey))(current.standardAccounts??=[]).push({...item,version:1,createdAt:time,createdBy:admin.id,updatedAt:time,updatedBy:admin.id});
  }
  const enabled=install?true:input.enabled;if(enabled===undefined)throw new ApiError(422,'TEMPLATE_STATE_REQUIRED','활성 여부가 필요합니다.');
  if(enabled&&!(current.standardAccounts??[]).some(x=>x.isDefault&&x.status==='ACTIVE'))throw new ApiError(409,'DEFAULT_TEMPLATE_EMPTY','활성 기본 과목을 먼저 지정하세요.');
  const before=current.accountTemplate??null;current.accountTemplate={enabled,version:(before?.version??0)+1,updatedAt:time,updatedBy:admin.id};
  current.audit.push({id:randomUUID(),actorUserId:admin.id,departmentId:null,entityType:'STANDARD_ACCOUNT',entityId:'junae-51-v1',action:install?'TEMPLATE_INSTALLED':'TEMPLATE_UPDATED',occurredAt:time,reason:input.reason,before,after:current.accountTemplate});return current;
 });return json({revision:next.revision,defaultCount:next.standardAccounts?.filter(x=>x.isDefault&&x.status==='ACTIVE').length});
}
