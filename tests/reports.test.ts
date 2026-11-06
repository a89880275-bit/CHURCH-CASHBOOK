import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileRepository } from '../server/file-store';
import { createApi } from '../server/api';
import { issueSession } from '../server/auth';
import { seed,ids } from '../server/seed';
import { koreaDate } from '../server/policy';
const origin='http://127.0.0.1:5173';
const acc={income:'00000000-0000-4000-8000-000000000031',expense:'00000000-0000-4000-8000-000000000032',paused:'00000000-0000-4000-8000-000000000033',unused:'00000000-0000-4000-8000-000000000034',missionIncome:'00000000-0000-4000-8000-000000000035',missionExpense:'00000000-0000-4000-8000-000000000036'};
let root:string,repo:FileRepository,api:ReturnType<typeof createApi>,admin:string,b:string,c:string;
function req(path:string,cookie?:string,body?:unknown,method='POST'){return new Request(origin+'/api'+path,{method:body===undefined?'GET':method,headers:{origin,...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
async function read(path:string,cookie=b){const response=await api(req(path,cookie));expect(response.status).toBe(200);return(await response.json()).data;}
async function post(date:string,amount:number,type:'INCOME'|'EXPENSE'='INCOME',accountId=acc.income,departmentId=ids.edu){const response=await api(req('/transactions',admin,{requestId:randomUUID(),departmentId,date,amount,type,accountId,description:'통계 검증 거래',remark:''}));expect(response.status).toBe(201);return(await response.json()).data.transaction;}
const scoped=(name:string)=>`/reports/${name}?departmentId=${ids.edu}&year=2026`;
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'accounting-reports-'));repo=new FileRepository(root);
  const s=seed(),now='2026-01-01T00:00:00Z';
  s.accounts=[
    {id:acc.income,departmentId:ids.edu,code:'I001',name:'회비',type:'INCOME',status:'ACTIVE',sortOrder:10},
    {id:acc.expense,departmentId:ids.edu,code:'E001',name:'교재',type:'EXPENSE',status:'ACTIVE',sortOrder:10},
    {id:acc.paused,departmentId:ids.edu,code:'E002',name:'과거 행사비',type:'EXPENSE',status:'ACTIVE',sortOrder:20},
    {id:acc.unused,departmentId:ids.edu,code:'E003',name:'미사용 계정',type:'EXPENSE',status:'ACTIVE',sortOrder:30},
    {id:acc.missionIncome,departmentId:ids.mission,code:'I001',name:'회비',type:'INCOME',status:'ACTIVE',sortOrder:10},
    {id:acc.missionExpense,departmentId:ids.mission,code:'E001',name:'교재',type:'EXPENSE',status:'ACTIVE',sortOrder:10},
  ];
  s.openingBalances=[{id:randomUUID(),departmentId:ids.edu,date:'2025-01-01',amount:500000,createdBy:ids.admin,createdAt:now,updatedBy:ids.admin,updatedAt:now},{id:randomUUID(),departmentId:ids.mission,date:'2026-01-01',amount:200000,createdBy:ids.admin,createdAt:now,updatedBy:ids.admin,updatedAt:now},{id:randomUUID(),departmentId:ids.music,date:'2026-01-01',amount:0,createdBy:ids.admin,createdAt:now,updatedBy:ids.admin,updatedAt:now}];
  await repo.initialize(s);api=createApi(repo,{origin,local:true});[admin,b,c]=await Promise.all(['local:admin','local:accountant','local:successor'].map(async sub=>(await issueSession(repo,sub,true)).split(';')[0]));
  await post('2025-12-31',100000);await post('2026-01-01',200000);await post('2026-01-31',50000,'EXPENSE',acc.expense);await post('2026-02-01',300000);await post('2026-02-28',30000,'EXPENSE',acc.paused);await post('2026-12-31',10000,'EXPENSE',acc.expense);await post('2026-01-10',400000,'INCOME',acc.missionIncome,ids.mission);await post('2026-01-11',100000,'EXPENSE',acc.missionExpense,ids.mission);
  const deleted=await post('2026-02-10',99999);await api(req('/transactions',admin,{departmentId:ids.edu,id:deleted.id,expectedVersion:1,reason:'중복 취소'},'DELETE'));
  const latest=await repo.control();await repo.updateControl(latest.revision,state=>{state.accounts.find(a=>a.id===acc.paused)!.status='INACTIVE';return state;});
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
describe('source-based financial reporting',()=>{
  it('rejects overflow when individually safe department totals are aggregated',async()=>{
    const overflowRepo=new FileRepository(join(root,'overflow')),s=seed();s.accounts=(await repo.control()).accounts;await overflowRepo.initialize(s);
    const cookie=(await issueSession(overflowRepo,'local:admin',true)).split(';')[0],overflowApi=createApi(overflowRepo,{origin,local:true});
    for(const [departmentId,accountId,amount]of [[ids.edu,acc.income,Number.MAX_SAFE_INTEGER],[ids.mission,acc.missionIncome,1]] as const){expect((await overflowApi(req('/transactions',cookie,{requestId:randomUUID(),departmentId,accountId,amount,date:'2026-01-01',type:'INCOME',description:'정수 한계 검증',remark:''}))).status).toBe(201);}
    for(const path of ['/reports/annual?year=2026','/reports/account-monthly?year=2026&type=INCOME','/reports/monthly?year=2026'])expect((await overflowApi(req(path,cookie))).status).toBe(422);
  });
  it('monthly, account, annual and ledger totals agree and never count deleted transactions',async()=>{
    const monthly=await read(scoped('monthly')),annual=await read(scoped('annual')),income=await read(scoped('account-monthly')+'&type=INCOME'),expense=await read(scoped('account-monthly')+'&type=EXPENSE'),ledger=await read(`/transactions?departmentId=${ids.edu}&from=2026-01-01&to=2026-12-31`);
    expect(monthly.rows).toHaveLength(12);expect(annual.summary).toMatchObject({income:500000,expense:90000,difference:410000,carryForward:600000,balance:1010000,count:5});
    expect(monthly.rows.reduce((sum:number,r:{income:number})=>sum+r.income,0)).toBe(annual.summary.income);
    expect(monthly.rows.reduce((sum:number,r:{expense:number})=>sum+r.expense,0)).toBe(annual.summary.expense);
    expect(income.grandTotal).toBe(ledger.totals.income);expect(expense.grandTotal).toBe(ledger.totals.expense);expect(annual.summary.balance).toBe(ledger.balance);
    expect(income.summary.income).toBe(income.grandTotal);expect(expense.summary.expense).toBe(expense.grandTotal);
  });
  it('carries prior years once and advances each monthly balance without adding carry as income',async()=>{
    const {rows}=await read(scoped('monthly'));
    expect(rows[0]).toMatchObject({carryForward:600000,income:200000,expense:50000,balance:750000});expect(rows[1]).toMatchObject({carryForward:750000,income:300000,expense:30000,balance:1020000});
    for(let i=1;i<12;i++)expect(rows[i].carryForward).toBe(rows[i-1].balance);
    expect(rows[11].balance).toBe(1010000);
  });
  it('includes inactive accounts with history and unused accounts with zero',async()=>{
    const result=await read(scoped('account-monthly')+'&type=EXPENSE');
    expect(result.rows.find((r:{id:string})=>r.id===acc.paused)).toMatchObject({status:'INACTIVE',total:30000});expect(result.rows.find((r:{id:string})=>r.id===acc.unused).months).toEqual(Array(12).fill(0));
    expect(result.monthlyTotals[0]).toBe(50000);expect(result.monthlyTotals[1]).toBe(30000);expect(result.monthlyTotals[11]).toBe(10000);
  });
  it('keeps identical account codes in separate departments in the administrator matrix',async()=>{
    const matrix=await read('/reports/account-monthly?year=2026&type=EXPENSE',admin);
    const same=matrix.rows.filter((r:{code:string})=>r.code==='E001');expect(same).toHaveLength(2);expect(same.map((r:{total:number})=>r.total).sort((a:number,b:number)=>a-b)).toEqual([60000,100000]);expect(matrix.grandTotal).toBe(190000);
  });
  it('global monthly and annual results equal the sum of department comparison rows',async()=>{
    const annual=await read('/reports/annual?year=2026',admin),compare=await read('/reports/departments?year=2026',admin),monthly=await read('/reports/monthly?year=2026',admin);
    expect(annual.summary).toMatchObject({income:900000,expense:190000,carryForward:800000,balance:1510000});
    expect(compare.rows.reduce((sum:number,r:{balance:number})=>sum+r.balance,0)).toBe(annual.summary.balance);
    expect(monthly.rows.reduce((sum:number,r:{income:number})=>sum+r.income,0)).toBe(compare.summary.income);expect(compare.rows).toHaveLength(3);
  });
  it('compares the selected month rather than a whole year',async()=>{
    const result=await read('/reports/departments?year=2026&month=2',admin);
    expect(result.summary).toMatchObject({income:300000,expense:30000});expect(result.from).toBe('2026-02-01');expect(result.to).toBe('2026-02-28');
  });
  it('dashboard KPI, top expenses and recent records use selected range while chart covers the year',async()=>{
    const result=await read(scoped('dashboard')+'&from=2026-02-01&to=2026-02-28');
    expect(result.summary).toMatchObject({income:300000,expense:30000,carryForward:750000,balance:1020000});expect(result.recentTransactions).toHaveLength(2);expect(result.monthly[0].income).toBe(200000);expect(result.topExpenses).toMatchObject([{accountId:acc.paused,amount:30000}]);
    expect(JSON.stringify(result)).not.toContain('local:');
  });
  it('recent records are limited to 10, sorted by accounting date and exclude deleted entries',async()=>{
    for(let day=1;day<=12;day++)await post(`2026-03-${String(day).padStart(2,'0')}`,1);
    const result=await read(scoped('dashboard')+'&from=2026-01-01&to=2026-12-31');expect(result.recentTransactions).toHaveLength(10);
    const dates=result.recentTransactions.map((t:{date:string})=>t.date);expect(dates).toEqual([...dates].sort().reverse());expect(result.recentTransactions.some((t:{amount:number})=>t.amount===99999)).toBe(false);
  });
  it('expense ranking uses committed account identities and the same period expense total',async()=>{
    const result=await read('/reports/dashboard?year=2026&from=2026-01-01&to=2026-12-31',admin);
    expect(result.topExpenses.map((r:{amount:number})=>r.amount)).toEqual([100000,60000,30000]);expect(result.topExpenses.reduce((s:number,r:{amount:number})=>s+r.amount,0)).toBe(result.summary.expense);
  });
  it.each(['monthly','annual','account-monthly','dashboard'])('requires current department access for %s',async name=>{
    const extra=name==='account-monthly'?'&type=EXPENSE':name==='dashboard'?'&from=2026-01-01&to=2026-12-31':'';
    expect((await api(req(`/reports/${name}?departmentId=${ids.edu}&year=2026${extra}`))).status).toBe(401);
    expect((await api(req(`/reports/${name}?departmentId=${ids.mission}&year=2026${extra}`,b))).status).toBe(403);
    expect((await api(req(`/reports/${name}?year=2026${extra}`,b))).status).toBe(403);
  });
  it('department comparison is administrator-only even with an assigned department in the URL',async()=>{expect((await api(req(scoped('departments'),b))).status).toBe(403);});
  it('handover revokes the old existing session and lets successor read unchanged historical totals',async()=>{
    const old=await read(scoped('annual')),state=await repo.control();
    expect((await api(req('/admin/assignments',admin,{departmentId:ids.edu,userIds:[ids.c],effectiveDate:koreaDate(),expectedRevision:state.revision,reason:'회계 인수인계'}))).status).toBe(200);
    expect((await api(req(scoped('annual'),b))).status).toBe(403);expect((await read(scoped('annual'),c)).summary).toEqual(old.summary);
    expect((await api(req(`/reports/annual?departmentId=${ids.music}&year=2026`,b))).status).toBe(200);
  });
  it('missing or midyear opening balance stays unknown in the affected monthly and global carry',async()=>{
    const state=await repo.control();await repo.updateControl(state.revision,s=>{s.openingBalances=s.openingBalances.filter(x=>x.departmentId!==ids.music);return s;});
    const result=await read('/reports/annual?year=2026',admin);expect(result.summary.carryForward).toBeNull();expect(result.summary.balance).toBeNull();expect(result.summary.missingBalance).toEqual(['찬양부']);
    const year2024=await read(`/reports/monthly?departmentId=${ids.edu}&year=2024`);expect(year2024.rows.every((r:{balance:number|null})=>r.balance===null)).toBe(true);
  });
  it('reports open, partial, and fully closed month states without treating them as annual approval',async()=>{
    const latest=await repo.control();await repo.updateControl(latest.revision,s=>{s.closings.push({id:randomUUID(),departmentId:ids.edu,period:'2026-01',status:'CLOSED'});return s;});
    expect((await read(scoped('annual'))).closedMonths).toBe(1);
    const global=await read('/reports/annual?year=2026',admin);expect(global.monthly[0].closingStatus).toBe('PARTIAL');expect(global.closedMonths).toBe(0);expect(global.monthly[1].closingStatus).toBe('OPEN');
  });
  it('rejects invalid years, months and dashboard date ranges',async()=>{
    expect((await api(req(`/reports/annual?departmentId=${ids.edu}&year=0`,b))).status).toBe(422);expect((await api(req('/reports/departments?year=2026&month=13',admin))).status).toBe(422);
    expect((await api(req(scoped('dashboard')+'&from=2025-01-01&to=2026-12-31',b))).status).toBe(422);
  });
  it('fails closed on a damaged transaction instead of understating the reports',async()=>{
    const ref=(await repo.control()).transactionRefs.find(r=>r.departmentId===ids.edu)!;await writeFile(join(root,'transactions',ref.departmentId,ref.id,`${ref.version}-${ref.hash}.json`),'{}');
    expect((await api(req(scoped('annual'),b))).status).toBe(503);
  });
});
