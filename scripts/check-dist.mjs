import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const forbidden=['OIDC_CLIENT_SECRET','COOKIE_KEY','BLOBS_STORE','DATABASE_URL','DATABASE_CA_CERT','local:admin','local:owner','.private/accounting','control/current.json','00000000-0000-4000-8000-000000000001'];
async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory()){await scan(path);continue;}if(/\.(json|map|env)$/i.test(entry.name))throw Error(`Unexpected static data or source map: ${path}`);const text=await readFile(path,'utf8');for(const marker of forbidden)if(text.includes(marker))throw Error(`Server marker found in ${path}: ${marker}`);}}
await scan('dist');console.log('PASS: no JSON, source maps, known server configuration markers or seed identity in dist. This is a focused check, not a general secret detector.');
