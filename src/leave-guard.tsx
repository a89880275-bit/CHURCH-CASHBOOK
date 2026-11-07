import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { Modal } from './components';

type Source={dirty:boolean;save:()=>Promise<boolean>;discard:()=>void};
const Guard=createContext<{source:React.MutableRefObject<Source|null>;request:(action:()=>void)=>void}|null>(null);
export function useLeaveGuard(){return useContext(Guard)?.request??((action:()=>void)=>action());}
export function useUnsavedChanges(dirty:boolean,save:()=>Promise<boolean>,discard:()=>void){
  const guard=useContext(Guard),latest=useRef({dirty,save,discard});latest.current={dirty,save,discard};
  useEffect(()=>{if(!guard)return;const source:Source={get dirty(){return latest.current.dirty;},save:()=>latest.current.save(),discard:()=>latest.current.discard()};guard.source.current=source;return()=>{if(guard.source.current===source)guard.source.current=null;};},[guard?.source]);
}
export function LeaveGuardProvider({children}:{children:ReactNode}){
  const source=useRef<Source|null>(null),allow=useRef(false);
  const blocker=useBlocker(()=>!allow.current&&source.current?.dirty===true);
  const [pending,setPending]=useState<{action:()=>void;cancel?:()=>void}|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState('');
  function request(action:()=>void){if(source.current?.dirty){setError('');setPending({action});}else action();}
  useEffect(()=>{if(blocker.state==='blocked'){setError('');setPending({action:()=>blocker.proceed(),cancel:()=>blocker.reset()});}},[blocker.state,blocker.location?.key]);
  function cancel(){if(saving)return;pending?.cancel?.();setPending(null);}
  function proceed(){if(!pending)return;allow.current=true;const action=pending.action;setPending(null);action();setTimeout(()=>{allow.current=false;},0);}
  useEffect(()=>{
    function unload(event:BeforeUnloadEvent){if(source.current?.dirty){event.preventDefault();event.returnValue='';}}
    window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);
  },[]);
  async function saveAndLeave(){if(!pending||saving)return;setSaving(true);try{if(await source.current?.save())proceed();else{pending.cancel?.();setPending(null);}}catch{setError('저장하지 못했습니다. 다시 시도해 주세요.');}finally{setSaving(false);}}
  return <Guard.Provider value={{source,request}}>{children}{pending&&<Modal title="작성 중인 장부를 저장할까요?" onClose={cancel}><p>저장하지 않은 입력이 있습니다. 저장한 뒤 이동하거나 입력을 버리고 이동할 수 있습니다.</p>{error&&<p role="alert" className="error">{error}</p>}<div className="actions"><button disabled={saving} onClick={cancel}>계속 작성</button><button disabled={saving} onClick={()=>{source.current?.discard();proceed();}}>버리고 이동</button><button className="primary" disabled={saving} onClick={()=>void saveAndLeave()}>{saving?'저장 중…':'저장 후 이동'}</button></div></Modal>}</Guard.Provider>;
}
