import { createServer } from 'node:http';
import { createApi } from './api';
import { FileRepository } from './file-store';
import { initialControl } from './bootstrap';
const repo = new FileRepository('.private/accounting');
await repo.initialize(initialControl());
const api=createApi(repo,{origin:'http://127.0.0.1:5173',local:true});
createServer(async(req,res)=>{
  try{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>((req.url??'').startsWith('/api/admin/backups/')?4*1024*1024:16384)){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
    const request=new Request('http://127.0.0.1:8889'+req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method??'GET')?{body:Buffer.concat(chunks)}:{})});
    const result=await api(request);res.writeHead(result.status,Object.fromEntries(result.headers.entries()));res.end(Buffer.from(await result.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Local server error');}
}).listen(8889,'127.0.0.1',()=>console.log('Local API http://127.0.0.1:8889 — persistent private JSON; loopback verification login only.'));
