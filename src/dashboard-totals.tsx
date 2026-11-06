import { useContext, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Wallet } from 'lucide-react';
import { api, Session } from './client';
import { currentPeriod, type ManagementPeriod } from '../shared/period';
import { PeriodPicker } from './period-picker';
type Summary = { carryForward: number | null; income: number; expense: number; difference: number; balance: number | null; missingCarry: string[]; missingBalance: string[] };
export function DashboardTotals() {
  const { me, department } = useContext(Session);
  const configured = me.departments.find(d => d.id === department)?.managementPeriod ?? 'MONTHLY';
  const [allMode, setAllMode] = useState<ManagementPeriod>('MONTHLY');
  const mode = department ? configured : allMode;
  const [range, setRange] = useState(() => currentPeriod(mode));
  const [data, setData] = useState<{key: string; value: Summary} | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const scope = `${department}:${mode}`, previous = useRef(scope), key = `${scope}:${range.from}:${range.to}`;
  useEffect(() => {
    if (previous.current !== scope) { previous.current = scope; setRange(currentPeriod(mode)); setData(null); return; }
    if (!department && me.user.role !== 'ADMIN') { setData(null); return; }
    let cancelled = false; setLoading(true); setError('');
    const params = new URLSearchParams(range); if (department) params.set('departmentId', department);
    api<Summary>('/reports/summary?' + params).then(value => { if (!cancelled) setData({key, value}); }).catch(e => { if (!cancelled) { setData(null); setError(e.message); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, range, me.revision]);
  const summary = data?.key === key ? data.value : null;
  return <><div className="dashboard-period"><PeriodPicker mode={mode} from={range.from} onChange={setRange} />{!department && me.user.role === 'ADMIN' && <label className="all-period-label">전체 부서 조회 기준<select value={allMode} onChange={e => setAllMode(e.target.value as ManagementPeriod)}><option value="MONTHLY">월별</option><option value="YEARLY">연도별</option></select></label>}<span className="muted small">{range.from} ~ {range.to}</span></div>{error && <p className="error" role="alert">{error}</p>}<div className="kpi-grid summary-kpis">{[
    { label:'이월금액', value:summary?.carryForward, color:'teal', icon:Wallet, note:'선택 기간 시작 전 잔액' },
    { label:mode === 'YEARLY' ? '연간 수입' : '월 수입', value:summary?.income, color:'green', icon:ArrowDownLeft, note:'선택 기간 활성 수입 합계' },
    { label:mode === 'YEARLY' ? '연간 지출' : '월 지출', value:summary?.expense, color:'orange', icon:ArrowUpRight, note:'선택 기간 활성 지출 합계' },
    { label:mode === 'YEARLY' ? '연간 차액' : '월 차액', value:summary?.difference, color:'blue', icon:Wallet, note:'수입 − 지출' },
    { label:'기간말 누적잔액', value:summary?.balance, color:'purple', icon:Wallet, note:'이월금액 + 기간 수입 − 기간 지출' },
  ].map(({label,value,color,icon:Icon,note}) => <section className="kpi" key={label}><div className="kpi-top"><span>{label}</span><span className={'metric-icon '+color}><Icon size={19}/></span></div><div className="ledger-amount">{loading ? '…' : value == null ? '—' : value.toLocaleString('ko-KR')}<span>원</span></div><small className="muted">{note}</small></section>)}</div>{summary && (summary.missingCarry.length > 0 || summary.missingBalance.length > 0) && <p className="muted small">기초잔액 미설정 또는 적용일 이후의 기간이 아닌 부서가 있어 이월·누적잔액의 일부를 확정할 수 없습니다. {Array.from(new Set([...summary.missingCarry,...summary.missingBalance])).join(', ')}</p>}</>;
}
