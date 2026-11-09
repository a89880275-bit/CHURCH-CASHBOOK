import { scopedRequest, sessionVersion, assertSessionVersion, sessionCleanup } from './session-boundary';
export async function downloadApi(path:string,filename:string){
  const version=sessionVersion();
  const blob=await scopedRequest('/api'+path,{},async (response,assertCurrent)=>{
  if(!response.ok){let message='다운로드하지 못했습니다.';try{message=(await response.json()).error?.message??message;}catch{}assertCurrent();if(response.status===401)window.dispatchEvent(new Event('session-expired'));throw new Error(message);}
    return response.blob();
  });
  assertSessionVersion(version);
  const url=URL.createObjectURL(blob),link=document.createElement('a'),release=sessionCleanup(()=>URL.revokeObjectURL(url));link.href=url;link.download=filename;link.click();setTimeout(release,1000);
}
