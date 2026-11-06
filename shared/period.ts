export type ManagementPeriod = 'MONTHLY' | 'YEARLY';
export function koreaDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function periodRange(mode: ManagementPeriod, year: number, month = 1) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) throw new RangeError('Invalid accounting period');
  const y = String(year).padStart(4, '0'), m = String(month).padStart(2, '0');
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mode === 'YEARLY' ? { from: `${y}-01-01`, to: `${y}-12-31` } : { from: `${y}-${m}-01`, to: `${y}-${m}-${days[month - 1]}` };
}
export function currentPeriod(mode: ManagementPeriod, date = koreaDate()) { return periodRange(mode, Number(date.slice(0, 4)), Number(date.slice(5, 7))); }
