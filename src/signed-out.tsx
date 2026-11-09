import { useState } from 'react';
import { api } from './client';
export function SignedOut(){
  const incomplete=new URLSearchParams(location.search).has('incomplete'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function retry(){setBusy(true);try{const next=await api<{next:string}>('/auth/logout',{mode:'logout'});location.replace(next.next);}catch{setError('로그아웃을 완료하지 못했습니다. 잠시 후 다시 시도하세요.');setBusy(false);}}
  return <div className="full-center"><section className="panel padded"><h1>{incomplete?'앱 세션은 종료되었습니다':'로그아웃되었습니다'}</h1><p>{incomplete?'Auth0 로그인 종료는 확인하지 못했습니다. 보안 로그아웃을 다시 시도하세요.':'다른 탭에서도 계정이 전환됩니다. 공용 PC에서는 사용 후 창을 닫으세요.'}</p>{error&&<p role="alert">{error}</p>}{incomplete?<button disabled={busy} onClick={()=>void retry()}>Auth0 로그아웃 다시 시도</button>:<a className="button primary" href="/">로그인 화면으로</a>}</section></div>;
}
