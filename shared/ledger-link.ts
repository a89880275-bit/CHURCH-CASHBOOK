export type LedgerLinkFilters = { from?: string; to?: string; type?: 'INCOME'|'EXPENSE'; accountId?: string; keyword?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(value+'T00:00:00Z'); return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value; }
export function ledgerLink(departmentId: string, filters: LedgerLinkFilters) {
  const params = new URLSearchParams({ departmentId });
  for (const [key,value] of Object.entries(filters)) if (value) params.set(key,value);
  return '/ledger?'+params;
}
export function parseLedgerSearch(search: string): { departmentId?: string; filters: LedgerLinkFilters; invalid: boolean } {
  const params = new URLSearchParams(search), filters: LedgerLinkFilters = {};
  const departmentId = params.get('departmentId') ?? undefined;
  let invalid = !!departmentId && !uuid.test(departmentId);
  for (const key of ['from','to'] as const) { const value = params.get(key); if (value) { if (validDate(value)) filters[key] = value; else invalid = true; } }
  const account = params.get('accountId'); if (account) { if (uuid.test(account)) filters.accountId = account; else invalid = true; }
  const type = params.get('type'); if (type) { if (type==='INCOME'||type==='EXPENSE') filters.type = type; else invalid = true; }
  const keyword = params.get('keyword'); if (keyword) filters.keyword = keyword.slice(0,100);
  if (filters.from && filters.to && filters.from > filters.to) invalid = true;
  return { departmentId, filters, invalid };
}
