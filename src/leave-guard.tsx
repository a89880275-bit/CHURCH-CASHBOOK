import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './components';

type Source={dirty:boolean;save:()=>Promise<boolean>;discard:()=>void};
const Guard=createContext<{source:React.MutableRefObject<Source|null>;request:(action:()=>void)=>void}|null>(null);
export function useLeaveGuard(){return useContext(Guard)?.request??((action:()=>void)=>action());}
export function useUnsavedChanges(dirty:boolean,save:()=>Promise<boolean>,discard:()=>void){
  const guard=useContext(Guard),latest=useRef({dirty,save,discard});latest.current={dirty,save,discard};
  useEffect(()=>{if(!guard)return;const source:Source={get dirty(){return latest.current.dirty;},save:()=>latest.current.save(),discard:()=>latest.current.discard()};guard.source.current=source;return()=>{if(guard.source.current===source)guard.source.current=null;};},[guard?.source]);
}
export function LeaveGuardProvider({children}:{children:ReactNode}){
  const source=useRef<Source|null>(null),navigate=useNavigate();
  const [pending,setPending]=useState<{action:()=>void}|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState('');
  function request(action:()=>void){if(source.current?.dirty){setError('');setPending({action});}else action();}
  useEffect(()=>{
    function click(event:MouseEvent){
      if(!source.current?.dirty||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      const link=(event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement|null;
      if(!link||link.target==='_blank'||link.hasAttribute('download')||link.href===window.location.href)return;
      const url=new URL(link.href);if(!['http:','https:'].includes(url.protocol))return;
      event.preventDefault();event.stopPropagation();request(()=>url.origin===window.location.origin?navigate(url.pathname+url.search+url.hash):window.location.assign(url.href));
    }
    function unload(event:BeforeUnloadEvent){if(source.current?.dirty){event.preventDefault();event.returnValue='';}}
    document.addEventListener('click',click,true);window.addEventListener('beforeunload',unload);
    return()=>{document.removeEventListener('click',click,true);window.removeEventListener('beforeunload',unload);};
  },[navigate]);
  async function saveAndLeave(){if(!pending||saving)return;setSaving(true);try{if(await source.current?.save()){const action=pending.action;setPending(null);action();}else{setError('저장하지 못했습니다. 장부 입력값과 오류를 확인해 주세요.');setPending(null);}}catch{setError('저장하지 못했습니다. 다시 시도해 주세요.');}finally{setSaving(false);}}
  return <Guard.Provider value={{source,request}}>{children}{pending&&<Modal title="작성 중인 장부를 저장할까요?" onClose={()=>!saving&&setPending(null)}><p>저장하지 않은 입력이 있습니다. 저장한 뒤 이동하거나 입력을 버리고 이동할 수 있습니다.</p>{error&&<p role="alert" className="error">{error}</p>}<div className="actions"><button disabled={saving} onClick={()=>setPending(null)}>계속 작성</button><button disabled={saving} onClick={()=>{source.current?.discard();const action=pending.action;setPending(null);action();}}>버리고 이동</button><button className="primary" disabled={saving} onClick={()=>void saveAndLeave()}>{saving?'저장 중…':'저장 후 이동'}</button></div></Modal>}</Guard.Provider>;
}
