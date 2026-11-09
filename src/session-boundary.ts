let generation=0, context='';
const pending=new Set<AbortController>();
const cleanups=new Set<()=>void>();
export class StaleSession extends Error { constructor(){super('계정이 변경되어 이전 요청을 중단했습니다.');} }
export const sessionVersion=()=>generation;
export function assertSessionVersion(version:number){if(version!==generation)throw new StaleSession();}
export function sessionCleanup(cleanup:()=>void){cleanups.add(cleanup);return()=>{cleanup();cleanups.delete(cleanup);};}
export function clearSessionRequests(){generation++;context='';for(const controller of pending)controller.abort();pending.clear();for(const cleanup of cleanups)cleanup();cleanups.clear();}
export function activateSession(next:string){if(context!==next){clearSessionRequests();context=next;}}
export async function scopedRequest<T>(url:string,init:RequestInit,read:(response:Response,assertCurrent:()=>void)=>Promise<T>):Promise<T>{
  const epoch=generation, controller=new AbortController();pending.add(controller);
  const headers=new Headers(init.headers);if(context)headers.set('x-session-context',context);
  try{
    const response=await fetch(url,{...init,headers,credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(epoch!==generation)throw new StaleSession();
    const result=await read(response,()=>{if(epoch!==generation)throw new StaleSession();});
    if(epoch!==generation)throw new StaleSession();
    return result;
  }catch(error){if(epoch!==generation)throw new StaleSession();throw error;}
  finally{pending.delete(controller);}
}
let channel:BroadcastChannel|undefined;
export function announceSessionChange(){
  channel?.postMessage('changed');
  try{localStorage.setItem('cashbook-session-event',crypto.randomUUID());}catch{/* Browser storage may be disabled. */}
}
export function listenSessionChanges(changed:()=>void){
  if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel('cashbook-session');channel.onmessage=()=>changed();}
  const storage=(event:StorageEvent)=>{if(event.key==='cashbook-session-event')changed();};
  window.addEventListener('storage',storage);
  return()=>{channel?.close();channel=undefined;window.removeEventListener('storage',storage);};
}
