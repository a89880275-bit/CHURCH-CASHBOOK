import {afterEach,describe,it,expect,vi} from 'vitest';
import {activateSession,clearSessionRequests,scopedRequest,sessionVersion,assertSessionVersion,sessionCleanup} from '../src/session-boundary';
import {downloadApi} from '../src/download';
afterEach(()=>{clearSessionRequests();vi.unstubAllGlobals();});
describe('client account boundaries',()=>{
 it.each([['admin','staff'],['staff','admin']])('cancels %s requests and rejects late responses after %s activation',async(old,next)=>{
  let resolve!:(r:Response)=>void;let signal:AbortSignal|undefined;
  vi.stubGlobal('fetch',vi.fn((_url,init)=>{signal=init.signal;return new Promise<Response>(r=>resolve=r);}));
  activateSession(old);const result=scopedRequest('/api/transactions',{},r=>r.json());
  const failed=expect(result).rejects.toThrow('계정이 변경');
  activateSession(next);expect(signal!.aborted).toBe(true);resolve(Response.json({private:'old account'}));await failed;
 });
 it('rejects a response whose body completes after a switch',async()=>{
  let finish!:(v:unknown)=>void;vi.stubGlobal('fetch',vi.fn(async()=>new Response('')));
  activateSession('old');const result=scopedRequest('/api/reports',{},()=>new Promise(r=>finish=r));
  await Promise.resolve();const failed=expect(result).rejects.toThrow();activateSession('new');finish({private:'old report'});await failed;
 });
 it('sends only the active context, never an authentication token',async()=>{
  const request=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({}));vi.stubGlobal('fetch',request);activateSession('staff-context');
  await scopedRequest('/api/transactions',{method:'POST'},r=>r.json());
  expect(new Headers(request.mock.calls[0][1].headers).get('x-session-context')).toBe('staff-context');
  expect(request.mock.calls[0][1].cache).toBe('no-store');
 });
 it('releases temporary downloads and invalidates chained actions on logout',()=>{
  activateSession('old');const version=sessionVersion(),cleanup=vi.fn();sessionCleanup(cleanup);clearSessionRequests();
  expect(cleanup).toHaveBeenCalledTimes(1);expect(()=>assertSessionVersion(version)).toThrow();
 });
 it('does not let a late old-account download error expire the new account',async()=>{
  const events=new EventTarget(),expired=vi.fn();events.addEventListener('session-expired',expired);vi.stubGlobal('window',events);
  let finish!:(value:unknown)=>void;
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:401,json:()=>new Promise(resolve=>finish=resolve)})));
  activateSession('old');const result=downloadApi('/transactions/export.xlsx','test.xlsx');
  const failed=expect(result).rejects.toThrow('계정이 변경');await Promise.resolve();
  activateSession('new');finish({error:{message:'expired'}});await failed;expect(expired).not.toHaveBeenCalled();
 });
});
