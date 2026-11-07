import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Session, type Me } from '../src/client';
import { LedgerPage } from '../src/ledger';
import { currentPeriod, type ManagementPeriod } from '../shared/period';
import { ThemeProvider } from '../src/theme';
import { themes } from '../shared/theme';
describe('initial ledger period shown to the user',()=>{
  it.each(themes)('offers both Excel and department JSON export in %s',theme=>{const me:Me={user:{id:'admin',displayName:'검증',role:'ADMIN',loginId:'admin',theme},departments:[{id:'00000000-0000-4000-8000-000000000011',name:'검증',code:'QA',status:'ACTIVE'}],revision:1,local:true,writable:true};const html=renderToStaticMarkup(<MemoryRouter><Session.Provider value={{me,refresh:async()=>{},department:me.departments[0].id,setDepartment:()=>{}}}><ThemeProvider me={me}><LedgerPage/></ThemeProvider></Session.Provider></MemoryRouter>);expect(html).toContain('Excel 다운로드');expect(html).toContain('JSON 백업');});
  it('opens the exact reporting period and account from a valid drilldown URL',()=>{
    const dept='00000000-0000-4000-8000-000000000011',account='00000000-0000-4000-8000-000000000031';
    const me:Me={user:{id:'admin',displayName:'검증',role:'ADMIN',loginId:'admin'},departments:[{id:dept,name:'교육부',code:'EDU',status:'ACTIVE',managementPeriod:'YEARLY'}],revision:1,local:true,writable:true};
    const html=renderToStaticMarkup(<MemoryRouter initialEntries={[`/ledger?departmentId=${dept}&from=2026-02-01&to=2026-02-28&accountId=${account}&type=EXPENSE`]}><Session.Provider value={{me,refresh:async()=>{},department:dept,setDepartment:()=>{}}}><LedgerPage/></Session.Provider></MemoryRouter>);
    expect(html).toContain('value="2026-02-01"');expect(html).toContain('value="2026-02-28"');expect(html).toContain('2026-02-01 ~ 2026-02-28');
    expect(html).toContain('<option value="EXPENSE" selected="">지출</option>');
  });
  it.each(['MONTHLY','YEARLY'] as ManagementPeriod[])('keeps input dates and actual applied period consistent for %s departments',mode=>{
    const me:Me={user:{id:'admin',displayName:'검증',role:'ADMIN',loginId:'admin'},departments:[{id:'dept',name:'검증 부서',code:'QA',status:'ACTIVE',managementPeriod:mode}],revision:1,local:true,writable:true};
    const html=renderToStaticMarkup(<MemoryRouter><Session.Provider value={{me,refresh:async()=>{},department:'dept',setDepartment:()=>{}}}><LedgerPage/></Session.Provider></MemoryRouter>);
    const period=currentPeriod(mode);
    expect(html).toContain(`value="${period.from}"`);expect(html).toContain(`value="${period.to}"`);
    expect(html).toContain(`${period.from} ~ ${period.to}`);
  });
});
