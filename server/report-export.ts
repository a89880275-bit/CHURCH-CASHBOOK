import { handleReports } from './reports';
import { workbook } from './xlsx';

export async function handleReportExport(a:Parameters<typeof handleReports>[0]){
  const routes=['monthly','account-monthly','annual','departments'];
  if(a.method!=='GET'||!routes.some(r=>a.path===`/api/reports/${r}.xlsx`))return null;
  const response=await handleReports({...a,path:a.path.replace('.xlsx','')});if(!response)return null;
  const {data}=await response.json();const rows:(string|number|null)[][]=[['보고서',a.path],['연도',data.year],['잔액 기준','기초잔액 및 전체 활성 거래 · 미설정 잔액은 미설정으로 표시']];
  if(a.path.includes('account-monthly')){
    rows.push(['부서','계정코드','계정명',...Array.from({length:12},(_,i)=>`${i+1}월`),'연간 합계']);
    for(const r of data.rows)rows.push([r.departmentName,r.code,r.name,...r.months,r.total]);rows.push(['합계','','',...data.monthlyTotals,data.grandTotal]);
  }else if(a.path.includes('departments')){
    rows.push(['기간',data.from,data.to],['부서','이월','수입','지출','차액','기말잔액']);for(const r of data.rows)rows.push([r.departmentName,r.carryForward,r.income,r.expense,r.difference,r.balance]);
  }else{
    rows.push(['월','이월','수입','지출','차액','기말잔액','마감 상태']);for(const r of data.rows??data.monthly)rows.push([r.month,r.carryForward,r.income,r.expense,r.difference,r.balance,r.closingStatus]);
  }
  if(data.summary){const s=data.summary;rows.push([],['조회 요약'],['이월금액',s.carryForward],['수입 합계',s.income],['지출 합계',s.expense],['차액',s.difference],['기말잔액',s.balance]);}
  return new Response(new Uint8Array(workbook(rows)),{headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','content-disposition':`attachment; filename="report-${data.year}.xlsx"`}});
}
