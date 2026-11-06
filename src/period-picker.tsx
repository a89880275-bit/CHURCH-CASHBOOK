import { periodRange, type ManagementPeriod } from '../shared/period';
export function PeriodPicker({ mode, from, onChange }: { mode: ManagementPeriod; from: string; onChange: (range: { from: string; to: string }) => void }) {
  const year = Number(from.slice(0,4)), month = Number(from.slice(5,7));
  return <div className="period-picker"><span className="pill">{mode === 'YEARLY' ? '연도별 관리' : '월별 관리'}</span><label>회계연도<input aria-label="회계연도" type="number" min={1} max={9999} value={year} onChange={e => { const next = e.target.valueAsNumber; if (Number.isInteger(next) && next >= 1 && next <= 9999) onChange(periodRange(mode, next, month)); }} /></label>{mode === 'MONTHLY' && <label>조회 월<select aria-label="조회 월" value={month} onChange={e => onChange(periodRange(mode, year, Number(e.target.value)))}>{Array.from({length:12},(_,i) => <option key={i+1} value={i+1}>{i+1}월</option>)}</select></label>}<span className="period-range">{from}</span></div>;
}
