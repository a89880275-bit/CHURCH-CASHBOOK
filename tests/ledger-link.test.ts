import {describe,expect,it} from 'vitest';
import {ledgerLink,parseLedgerSearch} from '../shared/ledger-link';
const departmentId='00000000-0000-4000-8000-000000000011',accountId='00000000-0000-4000-8000-000000000031';
describe('report drilldown contracts',()=>{
  it('preserves department, exact period, account and type into the ledger',()=>{
    const filters={from:'2026-02-01',to:'2026-02-28',accountId,type:'EXPENSE' as const};
    const link=ledgerLink(departmentId,filters);expect(parseLedgerSearch(link.slice(link.indexOf('?')))).toEqual({departmentId,filters,invalid:false});
  });
  it.each(['?departmentId=forged','?from=2026-02-30','?from=2026-03-01&to=2026-02-01','?accountId=../secret','?type=OTHER'])('rejects malformed drilldown %s',search=>{expect(parseLedgerSearch(search).invalid).toBe(true);});
});
