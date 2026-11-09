import {randomUUID} from 'node:crypto';
import {normalizeAccountText as norm,type StandardAccount} from '../shared/account-catalog';
import type {Control,User,Account} from './schema';
import {ApiError} from './store';
export function provisionAccounts(state:Control,user:User,departmentId:string,selected:StandardAccount[],reason:string):Account[]{
 const locals=state.accounts.filter(a=>a.departmentId===departmentId),used=new Set(locals.map(a=>norm(a.code))),cursor={INCOME:1,EXPENSE:1};
 const created:Account[]=[];
 for(const item of selected){
  if(locals.some(a=>a.standardAccountId===item.id))throw new ApiError(409,'ACCOUNT_ALREADY_IMPORTED','이미 등록된 과목입니다.');
  if(locals.some(a=>!a.standardAccountId&&a.type===item.type&&norm(a.name)===norm(item.name)))throw new ApiError(409,'LEGACY_ACCOUNT_REVIEW','기존 과목은 관리자 원본 연결 확인이 필요합니다.');
  const prefix=item.type==='INCOME'?'I':'E';let code='';do{if(cursor[item.type]>999999)throw new ApiError(409,'ACCOUNT_CODE_EXHAUSTED','자동 코드 발급 범위를 초과했습니다.');code=prefix+String(cursor[item.type]++).padStart(6,'0');}while(used.has(code));used.add(code);
  const account:Account={id:randomUUID(),departmentId,code,name:item.name,type:item.type,sortOrder:item.sortOrder,status:'ACTIVE',standardAccountId:item.id,standardAccountVersion:item.version,majorCategory:item.majorCategory,minorCategory:item.minorCategory,importedAt:new Date().toISOString(),importedBy:user.id,...(item.treatment?{treatment:item.treatment}:{})};state.accounts.push(account);created.push(account);
  state.audit.push({id:randomUUID(),actorUserId:user.id,departmentId,entityType:'ACCOUNT',entityId:account.id,action:'ACCOUNT_IMPORTED',occurredAt:new Date().toISOString(),reason,before:null,after:account});
 }
 return created;
}
export function provisionDefaults(state:Control,user:User,departmentId:string){
 if(!state.accountTemplate?.enabled)return;
 const defaults=(state.standardAccounts??[]).filter(a=>a.isDefault&&a.status==='ACTIVE');
 if(!defaults.length)throw new ApiError(409,'DEFAULT_TEMPLATE_EMPTY','활성 기본 과목이 없습니다. 관리자가 템플릿을 확인해야 합니다.');
 provisionAccounts(state,user,departmentId,defaults,'신규 부서 기본 계정과목 자동 등록');
}
