import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Link, NavLink, Navigate, Outlet, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { Coins, ArrowDownLeft, ArrowUpRight, Building2, ChartNoAxesCombined, Check, ChevronRight, CircleHelp, FileClock, LayoutDashboard, LockKeyhole, LogOut, Menu, Plus, RefreshCw, Settings2, ShieldCheck, Users, Wallet, X } from 'lucide-react';
import './styles.css';
import './themes.css';
import './diary-reference.css';
import './diary-ledger.css';
import './visual-refinements.css';
import './operations.css';
import { ClosingsPage, BackupsPage, AuditPage } from './operations';
import { ThemeProvider, ThemeSelector } from './theme';
import { DiaryIndexTabs } from './diary';
import { LeaveGuardProvider, useLeaveGuard } from './leave-guard';
import { LedgerPage } from './ledger';
import { DashboardPage as Dashboard } from './dashboard';
import { ReportsPage } from './reports';
import { api, ApiFailure, Session, type Me } from './client';
import { activateSession, clearSessionRequests, announceSessionChange, listenSessionChanges, StaleSession } from './session-boundary';
import { SignedOut } from './signed-out';
import { StandardAccountsPage } from './account-catalog';
import { UsersManagement as UsersPage, DepartmentsManagement as Assignments, AccountsManagement } from './master-data';
function App(){return location.pathname==='/signed-out'?<SignedOut/>:<AuthenticatedApp/>;}
function AuthenticatedApp(){
 const[connectionError,setConnectionError]=useState(''),[me,setMe]=useState<Me|null>(null),[loading,setLoading]=useState(true),[checking,setChecking]=useState(true),[department,setDepartment]=useState('');
 const serial=useRef(0),identity=useRef('');
 function clear(){serial.current++;identity.current='';clearSessionRequests();setMe(null);setDepartment('');setConnectionError('');}
 async function refresh(){
  const request=++serial.current;document.getElementById('root')!.style.visibility='hidden';setChecking(true);
  try{
   const next=await api<Me>('/me');if(request!==serial.current)return;
   const key=next.user.id+':'+(next.sessionContext??'legacy')+':'+next.user.role+':'+next.departments.map(d=>d.id+':'+d.status).join(',');
   activateSession(next.sessionContext??key);
   if(identity.current!==key){identity.current=key;setDepartment(next.user.role==='ADMIN'?'':next.departments[0]?.id??'');}
   else setDepartment(old=>next.user.role==='ADMIN'&&old===''?'':next.departments.some(d=>d.id===old)?old:next.departments[0]?.id??'');
   setMe(next);setConnectionError('');
   if(new URLSearchParams(window.location.search).get('signed_in')==='1'){window.history.replaceState(null,'',window.location.pathname);announceSessionChange();}
  }catch(e){if(request!==serial.current||e instanceof StaleSession)return;if(e instanceof ApiFailure&&e.status===401){identity.current='';clearSessionRequests();setMe(null);setDepartment('');}else{setMe(null);setDepartment('');setConnectionError((e as Error).message);}}
  finally{if(request===serial.current){setLoading(false);setChecking(false);}}
 }
 useEffect(()=>{if(!checking)document.getElementById('root')!.style.visibility='';},[checking,me]);
 useEffect(()=>{
  void refresh();const check=()=>void refresh(), changed=()=>{clear();void refresh();};
  const freeze=()=>{document.getElementById('root')!.style.visibility='hidden';clearSessionRequests();};
  const expired=()=>{clear();void refresh();};
  window.addEventListener('focus',check);window.addEventListener('pageshow',check);window.addEventListener('pagehide',freeze);window.addEventListener('session-expired',expired);window.addEventListener('account-cleared',clear);
  const stop=listenSessionChanges(changed);
  return()=>{serial.current++;stop();window.removeEventListener('focus',check);window.removeEventListener('pageshow',check);window.removeEventListener('pagehide',freeze);window.removeEventListener('session-expired',expired);window.removeEventListener('account-cleared',clear);};
 },[]);
 if(loading||(checking&&!me))return <div className="full-center"><RefreshCw className="spin"/> 세션을 확인하고 있습니다</div>;
 if(!me)return <>{connectionError&&<div role="alert" className="error">{connectionError}<button onClick={()=>void refresh()}>다시 연결</button></div>}<Login onLogin={refresh}/></>;
 return <Session.Provider key={identity.current} value={{me,refresh,department,setDepartment}}><ThemeProvider me={me}><LeaveGuardProvider><Routes><Route element={<Shell/>}><Route index element={<Dashboard/>}/><Route path="departments" element={<Admin><Assignments/></Admin>}/><Route path="users" element={<Admin><UsersPage/></Admin>}/><Route path="audit" element={<Admin><AuditPage/></Admin>}/><Route path="profile" element={<Profile/>}/><Route path="ledger" element={<LedgerPage/>}/><Route path="accounts" element={<AccountsManagement/>}/><Route path="standard-accounts" element={<Admin><StandardAccountsPage/></Admin>}/><Route path="reports" element={<ReportsPage/>}/><Route path="closings" element={<Admin><ClosingsPage/></Admin>}/><Route path="backups" element={<Admin><BackupsPage/></Admin>}/><Route path="*" element={<Navigate to="/" replace/>}/></Route></Routes></LeaveGuardProvider></ThemeProvider></Session.Provider>;
}
function Login({onLogin}:{onLogin:()=>Promise<void>}){const[error,setError]=useState(''),[busy,setBusy]=useState(false);const local=location.hostname==='127.0.0.1'||location.hostname==='localhost';const[identities,setIdentities]=useState<{identity:string;label:string;role:string}[]>([]);useEffect(()=>{if(local)api<typeof identities>('/auth/local-identities').then(setIdentities).catch(e=>setError(e.message));},[local]);
 async function localLogin(identity:string){setBusy(true);setError('');try{await api('/auth/local',{identity});await onLogin();announceSessionChange();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function otherLogin(){setBusy(true);setError('');try{try{const current=await api<Me>('/me');activateSession(current.sessionContext??'');}catch(e){if(!(e instanceof ApiFailure&&e.status===401))throw e;}const result=await api<{next:string}>('/auth/logout',{mode:'switch'});clearSessionRequests();announceSessionChange();window.location.replace(result.next);}catch(e){setError((e as Error).message);setBusy(false);}}
 return <div className="login-page"><section className="login-brand"><div className="brand-icon"><Wallet size={29}/></div><div className="eyebrow">JUNAE CHURCH · FINANCE</div><h1>맡겨진 재정을,<br/><span>투명하고 단단하게.</span></h1><p>부서의 기록은 이어지고,<br/>담당자의 권한은 명확하게 관리합니다.</p><div className="brand-footer"><ShieldCheck size={18}/> 부서별 접근 관리 · 안전한 회계 기록</div></section><section className="login-card"><div className="eyebrow">WELCOME BACK</div><h2>주내교회 회계관리</h2><p className="muted">배정된 부서의 회계 업무를 시작하세요.</p><div className="notice"><LockKeyhole size={20}/><div>관리형 인증으로 로그인<p>아이디와 비밀번호는 인증 제공자의 보안 로그인 화면에서 입력합니다.</p></div></div>{error&&<p role="alert" className="error">{error}</p>}{new URLSearchParams(location.search).has('error')&&<p role="alert" className="error">로그인을 완료하지 못했습니다. 다시 시도해 주세요.</p>}<a className="button primary wide" href="/api/auth/login">보안 로그인 <ArrowUpRight size={17}/></a>{!local&&<button className="button wide" disabled={busy} onClick={()=>void otherLogin()}>다른 계정으로 로그인</button>}{local&&<div className="local-login"><span className="pill">로컬 개발 전용</span><p>JSON 저장소에 등록된 계정으로 로컬 검수를 진행합니다. 비밀번호 없는 검수용 인증이며 운영에서는 사용할 수 없습니다.</p><div className="stack">{identities.map(item=><button key={item.identity} disabled={busy} onClick={()=>void localLogin(item.identity)}>{item.label} · {item.role==='ADMIN'?'관리자':'담당자'}<ChevronRight size={16}/></button>)}</div></div>}<p className="login-help"><CircleHelp size={15}/> 계정 발급 및 접근권한은 관리자에게 문의하세요.</p></section></div>;
}
const nav=[{to:'/',label:'대시보드',icon:LayoutDashboard},{to:'/ledger',label:'수입·지출 장부',icon:Wallet},{to:'/reports',label:'통계·보고서',icon:ChartNoAxesCombined},{to:'/accounts',label:'계정코드 관리',icon:Settings2}];
const adminNav=[{to:'/standard-accounts',label:'공통 계정과목 관리',icon:Settings2},{to:'/departments',label:'부서·담당자 관리',icon:Building2},{to:'/users',label:'사용자 관리',icon:Users},{to:'/closings',label:'마감 관리',icon:LockKeyhole},{to:'/audit',label:'감사이력',icon:FileClock},{to:'/backups',label:'백업·복원',icon:ShieldCheck}];
function Shell(){const requestLeave=useLeaveGuard();const navigate=useNavigate(),location=useLocation();const{me,refresh,department,setDepartment}=useContext(Session),[open,setOpen]=useState(false),[error,setError]=useState('');
 async function logout(mode:'logout'|'switch'='logout'){try{const result=await api<{next:string}>('/auth/logout',{mode});clearSessionRequests();announceSessionChange();window.dispatchEvent(new Event('account-cleared'));window.location.replace(result.next);}catch(e){setError((e as Error).message);}}
 return <div className="app-shell">{open&&<button aria-label="메뉴 닫기" className="scrim" onClick={()=>setOpen(false)}/>}<aside className={open?'sidebar open':'sidebar'}><Link className="brand" to="/"><div className="brand-icon"><Wallet size={23}/></div><div>주내교회 <span>부서 회계관리</span></div></Link><div className="workspace-label">WORKSPACE <span className="pill">v0.1</span></div><nav>{nav.map(({to,label,icon:Icon})=><NavLink key={to} end={to==='/'} to={to} onClick={()=>setOpen(false)}><Icon size={19}/>{label}</NavLink>)}{me.user.role==='ADMIN'&&<><div className="nav-label">관리자</div>{adminNav.map(({to,label,icon:Icon})=><NavLink key={to} to={to} onClick={()=>setOpen(false)}><Icon size={19}/>{label}</NavLink>)}</>}</nav><div className="sidebar-bottom"><div className="security"><ShieldCheck size={18}/><div>서버 권한 검증<span>요청마다 현재 배정 확인</span></div></div><Link className="user-card" to="/profile"><div className="avatar">{me.user.displayName.slice(0,1)}</div><div>{me.user.displayName}<span>{me.user.role==='ADMIN'?'시스템 관리자':'회계담당자'}</span></div><ChevronRight size={17}/></Link></div></aside><div className="main-area"><header><Link to="/" className="diary-header-brand"><span aria-hidden="true"><Coins size={34}/></span><span>회계관리 시스템<small>Accounting Diary</small></span><b aria-hidden="true">♡</b></Link><div className="header-left"><button className="icon-button mobile-menu" aria-label="메뉴 열기" onClick={()=>setOpen(true)}><Menu size={22}/></button><span className="header-label">현재 부서</span><select aria-label="현재 부서" value={department} onChange={e=>{const selected=e.target.value;requestLeave(()=>{setDepartment(selected);if(location.pathname==='/ledger'&&location.search)navigate('/ledger',{replace:true});});}}>{!me.departments.length&&me.user.role!=='ADMIN'&&<option value="">배정된 부서 없음</option>}{me.user.role==='ADMIN'&&<option value="">전체 부서</option>}{me.departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select><span className="header-divider"/><span className="muted">{department ? (me.departments.find(d=>d.id===department)?.managementPeriod === 'YEARLY' ? '연도별 관리' : '월별 관리') : '전체 부서 조회'}</span></div><div className="header-right"><ThemeSelector name={me.user.displayName}/><span className="status-dot"/>{me.local?'로컬 JSON':me.writable?'서버 저장':'조회 전용'}<button aria-label="로그아웃" onClick={()=>requestLeave(()=>void logout())}><LogOut size={17}/>로그아웃</button><button onClick={()=>requestLeave(()=>void logout('switch'))}>다른 계정으로 로그인</button></div></header><main>{error&&<div role="alert" className="error">{error}</div>}<div className="environment-banner"><ShieldCheck size={17}/><span>{me.local?'비공개 JSON에 변경 내용이 저장됩니다. 로컬 검수 인증 사용 중 · 운영 로그인은 별도 연결이 필요합니다.':me.writable?'부서 권한과 마감 상태를 확인한 뒤 변경 내용을 저장합니다.':'현재 조회 전용입니다. 등록·수정·삭제는 제한되어 있습니다.'}</span><span className="phase-badge">부서 회계관리</span></div><div className="diary-workspace"><DiaryIndexTabs/><Outlet/></div></main><footer>주내교회 부서 회계관리 <span>기록은 부서에, 권한은 담당자에게.</span></footer></div></div>;
}
function Title({eyebrow,title,description,children}:{eyebrow:string;title:string;description:string;children?:React.ReactNode}){return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="muted">{description}</p></div>{children}</div>;}
function Admin({children}:{children:React.ReactNode}){const{me}=useContext(Session);return me.user.role==='ADMIN'?children:<div className="panel empty-page"><LockKeyhole/><h1>관리자 전용 화면입니다</h1><Link to="/">대시보드로 돌아가기</Link></div>;}
function Profile(){const{me}=useContext(Session);return <><Title eyebrow="MY ACCOUNT" title="내 정보" description="서버에서 확인한 현재 계정 정보입니다."/><section className="panel padded"><h2>{me.user.displayName}</h2><p>{me.user.loginId} · {me.user.role==='ADMIN'?'관리자':'회계담당자'}</p><p className="muted">담당 부서: {me.departments.map(d=>d.name).join(', ')||'배정 없음'}</p><p className="muted">비밀번호 변경과 재설정은 관리형 인증 제공자에서 처리합니다.</p></section></>;}
const router=createBrowserRouter([{path:'*',element:<App/>}]);
createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>);
