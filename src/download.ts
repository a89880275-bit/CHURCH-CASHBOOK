export async function downloadApi(path:string,filename:string){
  const response=await fetch('/api'+path,{credentials:'same-origin'});
  if(!response.ok){let message='다운로드하지 못했습니다.';try{message=(await response.json()).error?.message??message;}catch{}if(response.status===401)window.dispatchEvent(new Event('session-expired'));throw new Error(message);}
  const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
