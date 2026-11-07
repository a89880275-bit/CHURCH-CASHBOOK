// Isolated browser QA only. Never imports or writes the user's .private/accounting data.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { FileRepository } from '../../server/file-store';
import { createApi } from '../../server/api';
import { issueSession } from '../../server/auth';
import { koreaDate } from '../../server/policy';
import { seed, ids } from '../../server/seed';

const root = await mkdtemp(join(tmpdir(), 'accounting-ledger-browser-'));
const repo = new FileRepository(root), origin = 'http://localhost:5174';
const state = seed();
state.users.forEach(u => { u.displayName = u.role === 'ADMIN' ? '검증 관리자' : '검증 담당자'; });
state.departments.forEach(d => { d.name = '검증용 ' + d.name; });
state.accounts = [
  { id: '00000000-0000-4000-8000-000000000031', departmentId: ids.edu, code: 'I001', name: '검증용 회비 수입', type: 'INCOME', sortOrder: 10, status: 'ACTIVE' },
  { id: '00000000-0000-4000-8000-000000000032', departmentId: ids.edu, code: 'E001', name: '검증용 교재비', type: 'EXPENSE', sortOrder: 20, status: 'ACTIVE' },
  { id: '00000000-0000-4000-8000-000000000033', departmentId: ids.mission, code: 'I001', name: '검증용 선교 수입', type: 'INCOME', sortOrder: 10, status: 'ACTIVE' },
  { id: '00000000-0000-4000-8000-000000000034', departmentId: ids.mission, code: 'E001', name: '검증용 선교 지출', type: 'EXPENSE', sortOrder: 20, status: 'ACTIVE' },
];
await repo.initialize(state);
const api = createApi(repo, { origin, local: true });
const cookie = (await issueSession(repo, 'local:admin', true)).split(';')[0];
for (const [type, amount, description, accountId] of [
  ['INCOME', 120000, '검증용 정기 회비', state.accounts[0].id],
  ['EXPENSE', 35000, '검증용 교재 구입', state.accounts[1].id],
] as const) {
  const response = await api(new Request(origin + '/api/transactions', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), departmentId: ids.edu, date: koreaDate(), accountId, type, description, amount, remark: '격리된 브라우저 검증 자료' }) }));
  if (response.status !== 201) throw new Error('QA fixture initialization failed');
}
for(const [month,type,amount,departmentId,accountId]of [
  ['01','INCOME',80000,ids.edu,state.accounts[0].id],['01','EXPENSE',20000,ids.edu,state.accounts[1].id],
  ['05','INCOME',60000,ids.edu,state.accounts[0].id],['05','EXPENSE',15000,ids.edu,state.accounts[1].id],
  ['09','INCOME',100000,ids.edu,state.accounts[0].id],['09','EXPENSE',40000,ids.edu,state.accounts[1].id],
  ['01','INCOME',200000,ids.mission,state.accounts[2].id],['11','EXPENSE',45000,ids.mission,state.accounts[3].id],
]as const){const response=await api(new Request(origin+'/api/transactions',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({requestId:randomUUID(),departmentId,date:koreaDate().slice(0,4)+'-'+month+'-01',accountId,type,description:`검증용 ${month}월 ${type==='INCOME'?'수입':'지출'}`,amount,remark:'격리된 브라우저 검증 자료'})}));if(response.status!==201)throw new Error('QA report fixture failed');}
for(const [departmentId,amount]of [[ids.edu,1000000],[ids.mission,500000],[ids.music,0]]as const){
  const openingResponse = await api(new Request(origin + '/api/admin/opening-balances', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({departmentId,date:koreaDate().slice(0,4)+'-01-01',amount,expectedRevision:(await repo.control()).revision,reason:'격리 검증 이월금액'}) }));
  if(openingResponse.status!==200)throw new Error('QA opening balance failed');
}
const http = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > ((req.url??'').startsWith('/api/admin/backups/')?4*1024*1024:16384)) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    const response = await api(new Request(origin + req.url, { method: req.method, headers, ...(!['GET','HEAD'].includes(req.method ?? 'GET') ? { body: Buffer.concat(chunks) } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers.entries())); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('QA server error'); }
});
await new Promise<void>(resolve => http.listen(8890, '127.0.0.1', resolve));
const vite = await createViteServer({ server: { port: 5174, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8890' } } });
await vite.listen();
console.log('Isolated ledger QA http://localhost:5174/ledger — synthetic data in OS temporary directory. Send exit on stdin to clean up.');
process.stdin.setEncoding('utf8');
process.stdin.on('data', async value => { if (String(value).trim() === 'exit') { await vite.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); process.exit(0); } });
