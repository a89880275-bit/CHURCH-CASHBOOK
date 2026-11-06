import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Me } from './client';
import { themes, themeLabels, type Theme } from '../shared/theme';

const ThemeContext = createContext<{theme:Theme;choose:(theme:Theme)=>Promise<void>;saving:boolean;message:string}>({theme:'modern-dark',choose:async()=>{},saving:false,message:''});
export const useTheme = () => useContext(ThemeContext);
export function ThemeProvider({me,children}:{me:Me;children:ReactNode}) {
  const [theme,setTheme]=useState<Theme>(me.user.theme??'modern-dark'),[saving,setSaving]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{document.documentElement.dataset.theme=theme;return()=>{delete document.documentElement.dataset.theme;};},[theme]);
  async function choose(next:Theme){
    if(saving)return;setTheme(next);setMessage('');
    if(!me.writable){setMessage('현재 화면에만 적용했습니다. 운영 저장소 검증 전에는 계정 설정을 저장할 수 없습니다.');return;}
    setSaving(true);
    try {
      const latest=await api<Me>('/me');
      await api('/me/preferences',{theme:next,expectedRevision:latest.revision},'PATCH');
      setMessage('계정에 저장됨 · 다른 기기 로그인 시 적용');
    } catch(e){setMessage(`화면에는 적용했지만 계정 저장에 실패했습니다. ${(e as Error).message}`);}
    finally{setSaving(false);}
  }
  return <ThemeContext.Provider value={{theme,choose,saving,message}}>{children}</ThemeContext.Provider>;
}
export function ThemeSelector({name}:{name:string}){
  const {theme,choose,saving,message}=useTheme();
  return <details className="theme-menu"><summary aria-label="사용자 및 테마 메뉴"><span className="theme-avatar">{name.slice(0,1)}</span><span>{name}</span><span aria-hidden="true">⌄</span></summary><div className="theme-popover"><span className="eyebrow">APPEARANCE</span><h2>나의 화면 테마</h2><p>화면과 입력 상태를 유지하며 전환합니다.</p><label htmlFor="theme-select">테마 선택</label><select id="theme-select" value={theme} disabled={saving} onChange={e=>void choose(e.target.value as Theme)}>{themes.map(t=><option key={t} value={t}>{themeLabels[t]}</option>)}</select><p role="status">{saving?'계정에 저장 중…':message||'테마 설정은 내 계정에 저장됩니다.'}</p></div></details>;
}
