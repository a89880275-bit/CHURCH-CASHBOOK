import { ArrowDownLeft, ArrowUpRight, Wallet } from 'lucide-react';
import type { MonthRow, ReportSummary } from './report-types';
export const money = (value:number|null|undefined) => value == null ? '—' : value.toLocaleString('ko-KR');
export function SummaryCards({summary,loading=false}:{summary:ReportSummary|null;loading?:boolean}) {
  return <><div className="kpi-grid summary-kpis">{[
    {label:'이월금액',value:summary?.carryForward,icon:Wallet,color:'teal',note:'기간 시작 전 잔액'},
    {label:'기간 수입',value:summary?.income,icon:ArrowDownLeft,color:'green',note:'활성 거래 수입 합계'},
    {label:'기간 지출',value:summary?.expense,icon:ArrowUpRight,color:'orange',note:'활성 거래 지출 합계'},
    {label:'기간 차액',value:summary?.difference,icon:Wallet,color:'blue',note:'수입 − 지출'},
    {label:'기간말 누적잔액',value:summary?.balance,icon:Wallet,color:'purple',note:'이월 + 수입 − 지출'},
  ].map(({label,value,icon:Icon,color,note})=><section key={label} className="kpi"><div className="kpi-top"><span>{label}</span><span className={'metric-icon '+color}><Icon size={19}/></span></div><div className={'ledger-amount '+(value!=null&&value<0?'negative':'')}>{loading?'…':money(value)}<span>원</span></div><small className="muted">{note}</small></section>)}</div>{summary&&(summary.missingCarry.length>0||summary.missingBalance.length>0)&&<p className="balance-warning">기초잔액 미설정 또는 적용일 확인이 필요한 부서가 있어 이월·누적잔액을 확정할 수 없습니다. {Array.from(new Set([...summary.missingCarry,...summary.missingBalance])).join(', ')}</p>}</>;
}
function compact(value:number) { return value>=100000000?`${(value/100000000).toLocaleString('ko-KR',{maximumFractionDigits:1})}억`:value>=10000?`${(value/10000).toLocaleString('ko-KR',{maximumFractionDigits:1})}만`:money(value); }
export function MonthlyChart({rows,year,onMonth,selectedMonth}:{rows:MonthRow[];year:number;onMonth:(month:number)=>void;selectedMonth?:number}) {
  const max=Math.max(0,...rows.flatMap(r=>[r.income,r.expense]));
  return <div className="monthly-chart" aria-label={`${year}년 월별 수입 지출 차트`}><div className="chart-scale"><span>{compact(max)}</span><span>{compact(max/2)}</span><span>0원</span></div><div className="bar-chart-scroll"><div className="bar-chart-plot">{rows.map(row=><button key={row.month} className={'bar-month '+(selectedMonth===row.month?'highlight':'')} onClick={()=>onMonth(row.month)} aria-label={`${row.month}월 수입 ${money(row.income)}원 지출 ${money(row.expense)}원, 상세 조회`} title={`${row.month}월 · 수입 ${money(row.income)}원 / 지출 ${money(row.expense)}원`}><span className="bar-pair"><span className="income-bar" style={{height:max?`${row.income/max*100}%`:'0%'}}/><span className="expense-bar" style={{height:max?`${row.expense/max*100}%`:'0%'}}/></span><span className="bar-label">{row.month}월</span></button>)}</div></div>{max===0&&<span className="zero-chart-label">선택 연도에 활성 거래가 없습니다.</span>}</div>;
}
export function Legend(){return <div className="legend"><span className="green-dot"/>수입 <span className="orange-dot"/>지출</div>;}
export function ClosingBadge({status}:{status:MonthRow['closingStatus']}) {return <span className={'closing-badge '+status.toLowerCase()}>{({OPEN:'미마감',CLOSED:'마감',PARTIAL:'일부 마감',EMPTY:'대상 없음'})[status]}</span>;}
