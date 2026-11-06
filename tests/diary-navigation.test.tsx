import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Session, type Me } from '../src/client';
import { DiaryIndexTabs } from '../src/diary';

function render(path:string,role:Me['user']['role']='ADMIN'){
  const me:Me={user:{id:'test',displayName:'검증',loginId:'test',role},departments:[],revision:1,local:true,writable:true};
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><Session.Provider value={{me,refresh:async()=>{},department:'',setDepartment:()=>{}}}><DiaryIndexTabs/></Session.Provider></MemoryRouter>);
}
describe('shared diary navigation',()=>{
  it.each(['/','/ledger','/accounts','/reports','/reports?tab=accounts'])('retains all workspace destinations at %s',path=>{
    const html=render(path);
    for(const href of ['/ledger','/accounts','/reports?tab=monthly','/reports?tab=accounts','/departments','/backups'])expect(html).toContain(`href="${href}"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
  it('keeps administrator destinations hidden from accountants',()=>{
    const html=render('/reports','ACCOUNTANT');
    for(const href of ['/departments','/closings','/backups'])expect(html).not.toContain(`href="${href}"`);
    expect(html).toContain('href="/ledger"');
  });
});
