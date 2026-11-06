import { ApiError, type Repository } from './store';
import type { Control, User } from './schema';
export const koreaDate = (date=new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export function allowedDepartments(state:Control,user:User,today=koreaDate()){
  return state.departments.filter(d=>user.role==='ADMIN' || (d.status==='ACTIVE' && state.assignments.some(a=>a.departmentId===d.id && a.userId===user.id && a.validFrom<=today && (!a.validTo || today<=a.validTo))));
}
export function requireAdmin(user:User){if(user.role!=='ADMIN') throw new ApiError(403,'ADMIN_REQUIRED','관리자 권한이 필요합니다.');}
export async function principal(repo:Repository,subject:string){
  const state=await repo.control(); const user=state.users.find(u=>u.subject===subject && u.status==='ACTIVE');
  if(!user) throw new ApiError(401,'UNAUTHENTICATED','로그인이 필요합니다.'); return {state,user};
}
export function requireDepartment(state:Control,user:User,id:string){if(!allowedDepartments(state,user).some(d=>d.id===id)) throw new ApiError(403,'DEPARTMENT_ACCESS_DENIED','해당 부서에 접근할 권한이 없습니다.');}
