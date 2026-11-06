import { FileRepository } from '../../server/file-store';
import { setTimeout as delay } from 'node:timers/promises';
const [root, name] = process.argv.slice(2);
const repo = new FileRepository(root, { beforePublish: () => delay(150) });
try { await repo.updateControl(1, s => { s.departments[0].name = name; return s; }); process.stdout.write('COMMITTED'); }
catch (error) { if ((error as { status?: number }).status === 409) process.stdout.write('CONFLICT'); else throw error; }
