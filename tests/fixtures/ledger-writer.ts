import { randomUUID } from 'node:crypto';
import { FileRepository } from '../../server/file-store';
import { createApi } from '../../server/api';
import { issueSession } from '../../server/auth';
import { ids } from '../../server/seed';
const repo = new FileRepository(process.argv[2]);
const cookie = (await issueSession(repo, 'local:accountant', true)).split(';')[0];
const origin = 'http://127.0.0.1:5173';
const response = await createApi(repo, { origin, local: true })(new Request(origin + '/api/transactions', {
  method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ requestId: randomUUID(), departmentId: ids.edu, date: '2026-05-20', accountId: '00000000-0000-4000-8000-000000000031', type: 'INCOME', description: '독립 프로세스 동시 입력', amount: 123, remark: '' }),
}));
if (response.status !== 201) throw new Error(`Ledger child request failed: ${response.status}`);
process.stdout.write('COMMITTED');
