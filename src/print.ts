import {scopedRequest,sessionVersion,assertSessionVersion,sessionCleanup} from './session-boundary';
export async function printApi(path:string,assertScope:()=>void){
 const version=sessionVersion();
 const html=await scopedRequest('/api'+path,{},async(response,assertCurrent)=>{
  if(!response.ok){let message='출력 자료를 불러오지 못했습니다.';try{message=(await response.json()).error?.message??message;}catch{/* Keep generic error. */}assertCurrent();if(response.status===401)window.dispatchEvent(new Event('session-expired'));throw new Error(message);}
  return response.text();
 });
 assertSessionVersion(version);assertScope();
 const frame=document.createElement('iframe');frame.title='거래내역 인쇄';frame.setAttribute('aria-hidden','true');frame.style.cssText='position:fixed;width:0;height:0;border:0;left:0;bottom:0';frame.sandbox.add('allow-same-origin','allow-modals');
 const release=sessionCleanup(()=>frame.remove());
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{release();reject(new Error('인쇄 문서를 열지 못했습니다. 다시 시도해 주세요.'));},15000);
  frame.onerror=()=>{clearTimeout(timer);release();reject(new Error('인쇄 문서를 열지 못했습니다.'));};
  frame.onload=()=>{clearTimeout(timer);try{assertSessionVersion(version);assertScope();const view=frame.contentWindow;if(!view)throw new Error('인쇄 창을 열지 못했습니다.');view.addEventListener('afterprint',release,{once:true});view.focus();view.print();resolve();}catch(e){release();reject(e);}};
  frame.srcdoc=html;document.body.append(frame);
 });
 setTimeout(release,120000);
}
