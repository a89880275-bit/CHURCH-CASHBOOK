import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, type Repository } from './store';
import { type Control, type User } from './schema';
import { requireAdmin, requireDepartment } from './policy';
import { readDepartment, periodBalances, totals } from './ledger';
import { periodRange } from '../shared/period';

const yearSchema=z.coerce.number().int().min(1).max(9999);
export function closingYear(state:Control,departmentId:string,year:number){const text=String(year).padStart(4,'0');return {months:Array.from({length:12},(_,i)=>{const period=`${text}-${String(i+1).padStart(2,'0')}`;return state.closings.find(c=>c.departmentId===departmentId&&c.period===period)??{period,status:'OPEN'};}),annual:state.annualClosings?.find(c=>c.departmentId===departmentId&&c.period===text)??null};}
export async function handleClosings(a:{path:string;method:string;url:URL;state:Control;user:User;repo:Repository;body:()=>Promise<unknown>}):Promise<Response|null>{
  if(a.path==='/api/closings'&&a.method==='GET'){
    const q=z.object({departmentId:z.uuid(),year:yearSchema}).strict().parse(Object.fromEntries(a.url.searchParams));requireDepartment(a.state,a.user,q.departmentId);
    return Response.json({success:true,data:{...closingYear(a.state,q.departmentId,q.year),revision:a.state.revision}});
  }
  if(a.path!=='/api/admin/closings'||a.method!=='POST')return null;
  requireAdmin(a.user);
  const q=z.object({departmentId:z.uuid(),kind:z.enum(['MONTH','YEAR']),operation:z.enum(['CLOSE','REOPEN']),period:z.string().regex(/^(?!0000)\d{4}(-(?:0[1-9]|1[0-2]))?$/),reason:z.string().trim().min(2).max(500),expectedRevision:z.number().int().positive()}).strict().parse(await a.body());
  if((q.kind==='MONTH')!==(q.period.length===7))throw new ApiError(422,'INVALID_PERIOD','마감 기간을 확인해 주세요.');
  if(!a.repo.writable||!a.repo.commitLedger)throw new ApiError(503,'WRITE_NOT_VERIFIED','검증된 쓰기 저장소가 필요합니다.');
  const next=await a.repo.commitLedger(async current=>{
    const actor=current.users.find(u=>u.id===a.user.id&&u.subject===a.user.subject&&u.status==='ACTIVE');if(!actor)throw new ApiError(401,'UNAUTHENTICATED','로그인이 필요합니다.');requireAdmin(actor);requireDepartment(current,actor,q.departmentId);
    if(current.revision!==q.expectedRevision)throw new ApiError(409,'VERSION_CONFLICT','마감 자료가 변경되었습니다. 새로 조회하세요.');
    const records=q.kind==='MONTH'?current.closings:(current.annualClosings??=[]),before=records.find(c=>c.departmentId===q.departmentId&&c.period===q.period);
    if((before?.status==='CLOSED')===(q.operation==='CLOSE'))throw new ApiError(409,'CLOSING_STATE_CHANGED','이미 요청한 마감 상태입니다. 새로 조회하세요.');
    const year=Number(q.period.slice(0,4));
    if(q.kind==='MONTH'&&q.operation==='REOPEN'&&current.annualClosings?.some(c=>c.departmentId===q.departmentId&&c.period===q.period.slice(0,4)&&c.status==='CLOSED'))throw new ApiError(409,'YEAR_CLOSED','연간 마감을 먼저 해제하세요.');
    if(q.kind==='YEAR'&&q.operation==='CLOSE'&&closingYear(current,q.departmentId,year).months.some(c=>c.status!=='CLOSED'))throw new ApiError(409,'MONTHS_OPEN','12개월을 모두 마감한 뒤 연간 마감할 수 있습니다.');
    const rows=await readDepartment(a.repo,current,q.departmentId),range=periodRange(q.kind==='MONTH'?'MONTHLY':'YEARLY',year,Number(q.period.slice(5))||1),balance=periodBalances(current,q.departmentId,rows,range.from,range.to),sum=totals(rows.filter(t=>t.date>=range.from&&t.date<=range.to));
    if(q.operation==='CLOSE'&&(balance.carryForward===null||balance.balance===null))throw new ApiError(422,'OPENING_REQUIRED','기간 시작 이전의 검증된 기초잔액이 필요합니다.');
    const now=new Date().toISOString(),after={id:before?.id??randomUUID(),departmentId:q.departmentId,period:q.period,status:q.operation==='CLOSE'?'CLOSED' as const:'OPEN' as const,updatedBy:actor.id,updatedAt:now,reason:q.reason,...(q.operation==='CLOSE'?{summary:{income:sum.income,expense:sum.expense,count:sum.count,carryForward:balance.carryForward!,balance:balance.balance!}}:{})};
    if(before)records.splice(records.indexOf(before),1,after);else records.push(after);
    current.audit.push({id:randomUUID(),actorUserId:actor.id,departmentId:q.departmentId,entityType:'CLOSING',entityId:after.id,action:q.kind==='MONTH'?(q.operation==='CLOSE'?'MONTH_CLOSED':'MONTH_REOPENED'):(q.operation==='CLOSE'?'YEAR_CLOSED':'YEAR_REOPENED'),occurredAt:now,reason:q.reason,before:before??null,after});return current;
  });return Response.json({success:true,data:{revision:next.revision,...closingYear(next,q.departmentId,Number(q.period.slice(0,4)))}});
}
